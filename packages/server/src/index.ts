/**
 * dsh-cloud-sync 参考服务端（protocol v1，docs/03-server-protocol.md §10）。
 *
 * 纯 HTTP 哑存储：对象即磁盘文件，key 直接映射数据目录相对路径。
 * 不理解密文、不做合并；revision = 内容 sha256 前 12 hex。
 *
 * 环境变量：
 *   DSH_SYNC_TOKEN   单用户模式：Bearer 凭据，数据落在 DATA_DIR 根（存量部署行为不变）
 *   DSH_SYNC_TOKENS  多用户模式："用户名:token" 逗号分隔，如 "alice:tok_a,bob:tok_b"；
 *                    每个用户的数据隔离在 DATA_DIR/<用户名>/ 下，列表天然按用户隔离。
 *                    与 DSH_SYNC_TOKEN 互斥（同时设置报错退出）。
 *   PORT             默认 8787
 *   DATA_DIR         默认 ./data
 *
 * 说明：路由接受 /v1/ 下任意安全字符 key（≥2 段），因此 `keys/<device>/kdf.json`
 * 与 `sessions/<device>/<name>` 走同一套接口；列表固定在 GET /v1/sessions。
 * 多用户模式下用户名只由 server 侧 token 映射决定，客户端不可指定——隔离不可伪造。
 *
 * 配对校验（可选）：请求可带 `X-DSH-User: <用户名>`，多用户模式下与 token 命中的
 * 租户名不一致返回 403（区别于 token 无效的 401）；头缺失或单用户模式不校验，
 * 老客户端与存量部署行为不变。该头只用于校验，绝不参与存储路径计算。
 */
import { createHash, timingSafeEqual } from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import http from 'node:http'
import path from 'node:path'

const PORT = Number(process.env.PORT ?? 8787)
const DATA_DIR = path.resolve(process.env.DATA_DIR ?? './data')
const MAX_OBJECT_BYTES = 512 * 1024 * 1024

/**
 * 租户：name 用于日志与多用户目录名；root 是 DATA_DIR 下的相对存储根
 * （单用户模式为 ''，即 DATA_DIR 本身，保持存量部署的数据布局不变）。
 */
type Tenant = { name: string; token: string; root: string }

const SAFE_SEGMENT = /^[a-zA-Z0-9._-]+$/

/** 解析 DSH_SYNC_TOKEN / DSH_SYNC_TOKENS 为租户表；配置非法时进程退出。 */
function parseTenants(): Tenant[] {
  const single = process.env.DSH_SYNC_TOKEN
  const multi = process.env.DSH_SYNC_TOKENS
  if (single && multi) {
    console.error('DSH_SYNC_TOKEN and DSH_SYNC_TOKENS are mutually exclusive')
    process.exit(1)
  }
  if (single) return [{ name: 'default', token: single, root: '' }]
  if (multi) {
    const tenants: Tenant[] = []
    for (const raw of multi.split(',')) {
      const entry = raw.trim()
      if (!entry) continue
      const sep = entry.indexOf(':')
      if (sep <= 0 || sep === entry.length - 1) {
        console.error(`DSH_SYNC_TOKENS: invalid entry "${entry}" (expected "name:token")`)
        process.exit(1)
      }
      const name = entry.slice(0, sep)
      const token = entry.slice(sep + 1)
      if (!SAFE_SEGMENT.test(name)) {
        console.error(`DSH_SYNC_TOKENS: invalid username "${name}" (allowed: [a-zA-Z0-9._-])`)
        process.exit(1)
      }
      if (tenants.some((t) => t.name === name || t.token === token)) {
        console.error(`DSH_SYNC_TOKENS: duplicate name or token "${name}"`)
        process.exit(1)
      }
      tenants.push({ name, token, root: name })
    }
    if (!tenants.length) {
      console.error('DSH_SYNC_TOKENS is empty')
      process.exit(1)
    }
    return tenants
  }
  console.error('DSH_SYNC_TOKEN or DSH_SYNC_TOKENS is required')
  process.exit(1)
}

const TENANTS = parseTenants()

/** 单用户模式（DSH_SYNC_TOKEN）：租户名是内部细节 'default'，不参与配对校验。 */
const SINGLE = TENANTS.length === 1 && TENANTS[0]!.root === ''

/** 解析 /v1/<seg...> 为 key；任一段含非法字符返回 null。 */
function keyFromUrl(pathname: string): string | null {
  const segs = pathname.split('/').filter(Boolean)
  if (segs[0] !== 'v1' || segs.length < 3) return null
  const parts = segs.slice(1).map(decodeURIComponent)
  if (parts.some((s) => !SAFE_SEGMENT.test(s))) return null
  return parts.join('/')
}

function keyToFile(tenant: Tenant, key: string): string {
  return path.join(DATA_DIR, tenant.root, ...key.split('/'))
}

function revisionOf(content: Buffer): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 12)
}

/** authenticate 的失败原因：token 无效（401）或 X-DSH-User 与租户名不配对（403）。 */
type AuthFailure = 'tokenInvalid' | 'userMismatch'

/** 校验 Bearer 凭据与可选的 X-DSH-User 配对；成功返回租户，失败返回原因。 */
function authenticate(req: http.IncomingMessage): { tenant: Tenant; failure?: undefined } | { tenant?: undefined; failure: AuthFailure } {
  const header = req.headers.authorization ?? ''
  const presented = Buffer.from(header.startsWith('Bearer ') ? header.slice(7) : '')
  let tenant: Tenant | null = null
  for (const candidate of TENANTS) {
    const expected = Buffer.from(candidate.token)
    if (presented.length === expected.length && timingSafeEqual(presented, expected)) {
      tenant = candidate
      break
    }
  }
  if (tenant === null) return { failure: 'tokenInvalid' }
  const raw = req.headers['x-dsh-user']
  const claimed = Array.isArray(raw) ? raw[0] : raw
  if (!SINGLE && claimed !== undefined && claimed !== tenant.name) {
    return { failure: 'userMismatch' }
  }
  return { tenant }
}

function log(req: http.IncomingMessage, key: string, status: number, bytes: number, tenant?: string): void {
  console.log(`${new Date().toISOString()} ${tenant ? `[${tenant}] ` : ''}${req.method} ${key} ${status} ${bytes}`)
}

function send(res: http.ServerResponse, status: number, body?: Buffer | string, headers: Record<string, string> = {}): void {
  const payload = typeof body === 'string' ? Buffer.from(body) : body
  res.writeHead(status, {
    'Content-Type': 'application/octet-stream',
    ...(payload ? { 'Content-Length': String(payload.length) } : {}),
    ...headers,
  })
  res.end(payload)
}

function readBody(req: http.IncomingMessage): Promise<Buffer | null> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let total = 0
    req.on('data', (chunk: Buffer) => {
      total += chunk.length
      if (total > MAX_OBJECT_BYTES) {
        resolve(null)
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

async function listObjects(tenant: Tenant, prefix?: string): Promise<unknown[]> {
  const objects: unknown[] = []
  async function walk(dir: string, rel: string): Promise<void> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      const entryRel = rel ? `${rel}/${entry.name}` : entry.name
      if (entry.isDirectory()) {
        await walk(path.join(dir, entry.name), entryRel)
      } else if (entry.isFile()) {
        const key = entryRel
        if (prefix && !key.startsWith(prefix)) continue
        const file = path.join(dir, entry.name)
        const stat = await fsp.stat(file)
        const content = await fsp.readFile(file)
        objects.push({
          key,
          size: stat.size,
          revision: revisionOf(content),
          lastModified: stat.mtime.toISOString(),
        })
      }
    }
  }
  await walk(path.join(DATA_DIR, tenant.root), '')
  objects.sort((a, b) => ((a as { key: string }).key < (b as { key: string }).key ? -1 : 1))
  return objects
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
  const pathname = url.pathname
  let tenant: Tenant | null = null

  try {
    if (req.method === 'GET' && pathname === '/v1/healthz') {
      send(res, 200)
      log(req, 'healthz', 200, 0)
      return
    }

    const auth = authenticate(req)
    if (auth.tenant === undefined) {
      const status = auth.failure === 'userMismatch' ? 403 : 401
      send(res, status)
      log(req, pathname, status, 0)
      return
    }
    tenant = auth.tenant

    if (req.method === 'GET' && pathname === '/v1/sessions') {
      const objects = await listObjects(tenant, url.searchParams.get('prefix') ?? undefined)
      const body = Buffer.from(JSON.stringify({ objects }), 'utf8')
      send(res, 200, body, { 'Content-Type': 'application/json' })
      log(req, 'sessions', 200, body.length, tenant.name)
      return
    }

    const key = keyFromUrl(pathname)
    if (!key) {
      send(res, 400)
      log(req, pathname, 400, 0, tenant.name)
      return
    }
    const file = keyToFile(tenant, key)

    if (req.method === 'GET') {
      let content: Buffer
      try {
        content = await fsp.readFile(file)
      } catch {
        send(res, 404)
        log(req, key, 404, 0, tenant.name)
        return
      }
      const revision = revisionOf(content)
      const headers = { 'X-Revision': revision, ETag: `"${revision}"` }
      const range = req.headers.range
      if (range) {
        const match = /^bytes=(\d+)-(\d*)$/.exec(range)
        if (!match) {
          send(res, 416, undefined, headers)
          log(req, key, 416, 0, tenant.name)
          return
        }
        const start = Number(match[1])
        const end = match[2] ? Math.min(Number(match[2]), content.length - 1) : content.length - 1
        if (start > end || start >= content.length) {
          send(res, 416, undefined, headers)
          log(req, key, 416, 0, tenant.name)
          return
        }
        const slice = content.subarray(start, end + 1)
        send(res, 206, slice, { ...headers, 'Content-Range': `bytes ${start}-${end}/${content.length}` })
        log(req, key, 206, slice.length, tenant.name)
        return
      }
      send(res, 200, content, headers)
      log(req, key, 200, content.length, tenant.name)
      return
    }

    if (req.method === 'PUT') {
      const body = await readBody(req)
      if (body === null) {
        send(res, 413)
        log(req, key, 413, 0, tenant.name)
        return
      }
      await fsp.mkdir(path.dirname(file), { recursive: true })

      const appendOffset = req.headers['x-append-offset']
      if (appendOffset !== undefined) {
        const offset = Number(appendOffset)
        if (!Number.isInteger(offset) || offset < 0) {
          send(res, 400)
          log(req, key, 400, 0, tenant.name)
          return
        }
        let current: Buffer
        try {
          current = await fsp.readFile(file)
        } catch {
          current = Buffer.alloc(0)
        }
        if (current.length + body.length > MAX_OBJECT_BYTES) {
          send(res, 413)
          log(req, key, 413, 0, tenant.name)
          return
        }
        if (offset !== current.length) {
          send(res, 409, JSON.stringify({ currentLength: current.length }), { 'Content-Type': 'application/json' })
          log(req, key, 409, 0, tenant.name)
          return
        }
        const handle = await fsp.open(file, 'a')
        try {
          await handle.write(body)
        } finally {
          await handle.close()
        }
        const revision = revisionOf(Buffer.concat([current, body]))
        send(res, 200, undefined, { 'X-Revision': revision })
        log(req, key, 200, body.length, tenant.name)
        return
      }

      if (body.length > MAX_OBJECT_BYTES) {
        send(res, 413)
        log(req, key, 413, 0, tenant.name)
        return
      }
      const tmp = `${file}.tmp-${process.pid}-${Date.now()}`
      await fsp.writeFile(tmp, body)
      await fsp.rename(tmp, file)
      const revision = revisionOf(body)
      send(res, 200, undefined, { 'X-Revision': revision })
      log(req, key, 200, body.length, tenant.name)
      return
    }

    if (req.method === 'DELETE') {
      try {
        await fsp.unlink(file)
      } catch {
        // 幂等：不存在也返回 200
      }
      send(res, 200)
      log(req, key, 200, 0, tenant.name)
      return
    }

    send(res, 405)
    log(req, pathname, 405, 0, tenant.name)
  } catch (error) {
    console.error('internal error:', error)
    send(res, 500)
    log(req, pathname, 500, 0, tenant?.name ?? '')
  }
})

await fsp.mkdir(DATA_DIR, { recursive: true })
server.listen(PORT, () => {
  const who = TENANTS.length === 1 && TENANTS[0]!.root === ''
    ? `single tenant, data dir ${DATA_DIR}`
    : `${TENANTS.length} tenants [${TENANTS.map((t) => t.name).join(', ')}], data dir ${DATA_DIR}/<user>/`
  console.log(`dsh-cloud-sync-server listening on :${PORT}, ${who}`)
})
