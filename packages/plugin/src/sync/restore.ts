/**
 * 下行恢复（docs/02 §4.3）：云端目录拉取、路径归位解析、header.cwd 单字段改写、
 * 经 locate() 落位、映射学习。与 cordis 解耦，纯函数 + 显式 deps 便于单测。
 *
 * 硬约束（§4.3）：
 * - 落位路径一律由 persistence 端口的 locate(header) 计算，本模块绝不自行
 *   复刻 projectKey 编码——v0 宿主透传服务方法，v1 宿主（locate 已私有化）
 *   由 persistence-port.ts 的布局推导兜底；
 * - 对文件字节的唯一改写是首帧 JSON 的 cwd 字段，事件正文一字节不动；
 * - 落位后唯一的 dsh 调用是 workspaceRegistry 挂载（公开服务方法）——
 *   sessionQuery 的 list() 走 persistence.list() 扫盘，文件就位即被发现；
 *   但 web 侧边栏按 workspace 成员关系分组，不挂载的会话只进「未分组」桶。
 */
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { decryptLog, decryptMeta, type SessionMeta } from '../crypto/envelope.js'
import type { SessionHeaderLike, SessionPersistenceLike } from '../dsh-types.js'
import { logKey } from './engine.js'
import { scanZstdFrames, zstdCompressAsync, zstdDecompressAsync, ZSTD_CHECKSUM_OPTIONS } from './frames.js'
import type { SyncClient } from './http-client.js'
import type { StateStore } from './state.js'

/**
 * 本机支持的会话格式版本兜底值（dsh core/session 的 SESSION_FORMAT_VERSION，
 * rc.1 与 0.1.3-alpha.1 均为 2）。运行时基准优先取本机会话 header 的 version
 * （见 fetchCatalog），本地无任何会话时才落到此常量。
 */
export const LOCAL_FORMAT_VERSION = 2

/** 恢复目录的一行（Host 计算好解析结果，Client 只负责呈现与改选）。 */
export interface CatalogEntry {
  sessionId: string
  device: string
  title: string
  updatedAt: number
  eventCount: number
  /** 来源 cwd（meta 记录的原样路径，可能在本机不存在） */
  cwd: string
  formatVersion: number
  existsLocal: boolean
  versionIncompatible: boolean
  /** 解析出的本机落位 cwd；未解析为 null（原样落位，恢复后未分组） */
  resolvedCwd: string | null
  resolution: 'mapping' | 'suggested' | 'none'
}

/** restoreCatalogJson 的载荷（Host→Client）。at 回显 restoreListRequestedAt。 */
export interface RestoreCatalog {
  at: number
  /** 本设备名（Client 据此默认勾选其他设备的会话） */
  selfDevice: string
  sessions: CatalogEntry[]
  /** '' 或错误码（unconfigured / unreachable / …），非空时 sessions 无意义 */
  error: string
}

/** restoreRequestJson 的载荷（Client→Host）。targetCwd 为 null 表示原样落位。 */
export interface RestoreRequest {
  at: number
  items: { sessionId: string; device: string; targetCwd: string | null }[]
}

/** restoreResultJson 的载荷（Host→Client）。at 回显请求的 at。 */
export interface RestoreResult {
  at: number
  ok: number
  failed: number
  firstError: string
}

/** startupNoticeJson 的载荷（Host→Client，启动检查发现他机增量时写）。 */
export interface StartupNotice {
  at: number
  count: number
}

/** mappingDeleteJson 的载荷（Client→Host）：删除一条已学习映射。 */
export interface MappingDelete {
  at: number
  from: string
}

/** 路径映射的一对（state.global.pathMappings 的元素形态）。 */
export interface MappingPair {
  from: string
  to: string
}

// ---- JSON 载荷的编解码（两端各自拼写，不跨半 import；Host 侧编码 + 防御性解码） ----

export function encodeCatalog(catalog: RestoreCatalog): string {
  return JSON.stringify(catalog)
}

export function decodeRestoreRequest(raw: string): RestoreRequest | undefined {
  try {
    const parsed = JSON.parse(raw) as RestoreRequest
    if (typeof parsed.at !== 'number' || !Array.isArray(parsed.items)) return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function encodeRestoreResult(result: RestoreResult): string {
  return JSON.stringify(result)
}

export function encodeMappings(mappings: MappingPair[]): string {
  return JSON.stringify(mappings)
}

export function decodeMappingDelete(raw: string): MappingDelete | undefined {
  try {
    const parsed = JSON.parse(raw) as MappingDelete
    if (typeof parsed.at !== 'number' || typeof parsed.from !== 'string') return undefined
    return parsed
  } catch {
    return undefined
  }
}

export function encodeStartupNotice(notice: StartupNotice): string {
  return JSON.stringify(notice)
}

// ---- 路径归位解析（§4.3 解析顺序，纯函数） ----

export interface Resolution {
  kind: 'mapping' | 'suggested' | 'none'
  cwd: string | null
}

/** 尾段名：路径最后一个非空段（'/home/alice/p/proj' → 'proj'）。 */
export function tailSegment(cwd: string): string {
  const segments = cwd.split('/').filter((segment) => segment.length > 0)
  return segments[segments.length - 1] ?? ''
}

/**
 * 解析来源 cwd 的本机落位：
 * 1. 已学习映射按前缀命中（首个命中即用，子路径按比例平移）；
 * 2. 未命中 → 来源路径尾段名在本机工作区 canonical path 中找同名目录作建议；
 * 3. 皆无 → none（调用方呈现「恢复后未分组」，仍可原样落位）。
 * 改选目录由 Client 交互完成，结果作为 targetCwd 随恢复请求回来，不在这层。
 */
export function resolveTargetCwd(
  sourceCwd: string,
  mappings: readonly MappingPair[],
  workspacePaths: readonly string[],
): Resolution {
  if (sourceCwd === '') return { kind: 'none', cwd: null }
  for (const mapping of mappings) {
    if (sourceCwd === mapping.from) return { kind: 'mapping', cwd: mapping.to }
    if (sourceCwd.startsWith(mapping.from + '/')) {
      return { kind: 'mapping', cwd: mapping.to + sourceCwd.slice(mapping.from.length) }
    }
  }
  const tail = tailSegment(sourceCwd)
  if (tail !== '') {
    const hit = workspacePaths.find((workspacePath) => tailSegment(workspacePath) === tail)
    if (hit !== undefined) return { kind: 'suggested', cwd: hit }
  }
  return { kind: 'none', cwd: null }
}

// ---- header.cwd 单字段改写（§4.3 铁律 2 的唯一例外） ----

/** 从完整日志明文中解析首帧首行的 SessionHeader。 */
export async function parseHeaderFromLog(logBytes: Buffer): Promise<SessionHeaderLike> {
  const scan = scanZstdFrames(logBytes, 1)
  if (scan.frames.length === 0) throw new Error('session log has no complete first frame')
  const first = await zstdDecompressAsync(logBytes.subarray(scan.frames[0].start, scan.frames[0].end))
  const text = first.toString('utf8')
  const newline = text.indexOf('\n')
  const headerLine = newline === -1 ? text : text.slice(0, newline)
  const parsed = JSON.parse(headerLine) as Record<string, unknown>
  if (parsed.type !== 'session' || typeof parsed.id !== 'string' || typeof parsed.version !== 'number') {
    throw new Error('first line is not a session header')
  }
  return parsed as unknown as SessionHeaderLike
}

/**
 * 改写日志明文的 header.cwd：解压首帧 → 首行 JSON 就地改 cwd 字段
 * （JSON.parse 保序，stringify 只动值不动键序）→ 按 dsh 的 checksum 参数重压缩
 * 替换首帧，其余帧字节原样拼接。
 */
export async function rewriteCwd(logBytes: Buffer, newCwd: string): Promise<Buffer> {
  const scan = scanZstdFrames(logBytes, 1)
  if (scan.frames.length === 0) throw new Error('session log has no complete first frame')
  const frame = scan.frames[0]
  const first = await zstdDecompressAsync(logBytes.subarray(frame.start, frame.end))
  const text = first.toString('utf8')
  const newline = text.indexOf('\n')
  const headerLine = newline === -1 ? text : text.slice(0, newline)
  const rest = newline === -1 ? '' : text.slice(newline)
  const parsed = JSON.parse(headerLine) as Record<string, unknown>
  if (parsed.type !== 'session') throw new Error('first line is not a session header')
  parsed.cwd = newCwd
  const rewritten = Buffer.from(JSON.stringify(parsed) + rest, 'utf8')
  const compressed = await zstdCompressAsync(rewritten, ZSTD_CHECKSUM_OPTIONS)
  return Buffer.concat([compressed, logBytes.subarray(frame.end)])
}

// ---- 映射学习（state.global.pathMappings，首个命中生效） ----

/** 学习一对映射：同 from 的旧条目被替换，新条目排到最前（首个命中）。 */
export async function learnMapping(state: StateStore, from: string, to: string): Promise<MappingPair[]> {
  const mappings = state.getGlobal().pathMappings.filter((pair) => pair.from !== from)
  mappings.unshift({ from, to })
  await state.setGlobal({ pathMappings: mappings })
  return mappings
}

/** 删除一条映射（设置卡「路径映射」区的删除按钮）。 */
export async function deleteMapping(state: StateStore, from: string): Promise<MappingPair[]> {
  const mappings = state.getGlobal().pathMappings.filter((pair) => pair.from !== from)
  await state.setGlobal({ pathMappings: mappings })
  return mappings
}

// ---- 云端目录拉取 ----

export interface CatalogDeps {
  client: SyncClient
  /** scrypt 派生密钥（kdf 引导完成后） */
  key: Buffer
  persistence: SessionPersistenceLike
  state: StateStore
  /** 本机工作区 canonical path 列表（workspaceRegistry 缺失时传空数组） */
  workspacePaths: string[]
  /** 单个 meta 解密失败时回调（口令不匹配的兜底呈现走状态行，不打断目录） */
  onWarn?: (message: string) => void
}

const META_SUFFIX = '.meta.enc'

/**
 * 拉取全设备云端目录：列出 sessions/ 下全部 meta 对象，逐个下载解密，
 * 标注 existsLocal / versionIncompatible / 路径解析结果，按 updatedAt 倒序。
 */
export async function fetchCatalog(deps: CatalogDeps): Promise<CatalogEntry[]> {
  const objects = await deps.client.list('sessions/')
  const metaKeys = objects.filter((object) => object.key.endsWith(META_SUFFIX))
  const localHeaders = await deps.persistence.list()
  const localIds = new Set(localHeaders.map((header) => header.id))
  // 兼容基准优先取本机会话 header 的 version（即本机运行时的 SESSION_FORMAT_VERSION，
  // 上游 bump 后随本地新会话自适应）；本地一个会话都没有才落到常量兜底
  const localFormatVersion = localHeaders.reduce((max, header) => Math.max(max, header.version), LOCAL_FORMAT_VERSION)
  const mappings = deps.state.getGlobal().pathMappings

  const entries: CatalogEntry[] = []
  for (const object of metaKeys) {
    // key 形态：sessions/<device>/<sessionId>.meta.enc
    const segments = object.key.split('/')
    const device = segments[1] ?? ''
    const sessionId = segments[segments.length - 1].slice(0, -META_SUFFIX.length)
    let meta: SessionMeta
    try {
      meta = decryptMeta(deps.key, sessionId, await deps.client.download(object.key))
    } catch (error) {
      deps.onWarn?.(`meta 解密失败，跳过 ${object.key}：${String(error)}`)
      continue
    }
    const existsLocal = localIds.has(sessionId)
    const resolution = existsLocal || meta.cwd === ''
      ? { kind: 'none' as const, cwd: null }
      : resolveTargetCwd(meta.cwd, mappings, deps.workspacePaths)
    entries.push({
      sessionId,
      device,
      title: meta.title,
      updatedAt: meta.updatedAt,
      eventCount: meta.eventCount,
      cwd: meta.cwd,
      formatVersion: meta.formatVersion,
      existsLocal,
      versionIncompatible: meta.formatVersion > localFormatVersion,
      resolvedCwd: resolution.cwd,
      resolution: resolution.kind,
    })
  }
  // 最后更新倒序（01 §5.4）
  entries.sort((a, b) => b.updatedAt - a.updatedAt)
  return entries
}

// ---- 恢复执行 ----

export interface RestoreDeps {
  client: SyncClient
  key: Buffer
  persistence: SessionPersistenceLike
  state: StateStore
  /**
   * 落位后把会话挂进 workspace（web 侧边栏可见性的成员注册）。
   * 实现负责 resolveByPath/create/attachSession；缺省跳过（无 workspaceRegistry 环境）。
   */
  attachWorkspace?: (sessionId: string, cwd: string) => Promise<void>
  onWarn?: (message: string) => void
}

/**
 * 恢复选中会话：逐条下载 log.enc → 链式解密 → 需要时改写 header.cwd →
 * locate() 计算落位 → 原子写入（已存在拒绝覆盖）→ workspace 挂载 →
 * 学习实际使用的映射对。单条失败不中断其余（01 §5.4 与 syncAll 同语义）。
 */
export async function restoreSessions(
  deps: RestoreDeps,
  items: RestoreRequest['items'],
): Promise<RestoreResult> {
  let ok = 0
  let failed = 0
  let firstError = ''
  for (const item of items) {
    try {
      await restoreOne(deps, item)
      ok += 1
    } catch (error) {
      failed += 1
      firstError ||= `${item.sessionId}: ${String(error)}`.slice(0, 300)
      deps.onWarn?.(`恢复失败 ${item.sessionId}：${String(error)}`)
    }
  }
  return { at: 0, ok, failed, firstError }
}

async function restoreOne(deps: RestoreDeps, item: RestoreRequest['items'][number]): Promise<string> {
  const encrypted = await deps.client.download(logKey(item.device, item.sessionId))
  let plaintext = decryptLog(deps.key, item.sessionId, encrypted)
  const header = await parseHeaderFromLog(plaintext)
  // 落位身份以日志内 header 为准：云端 key 与内容不匹配时拒绝，防止写错目录
  if (header.id !== item.sessionId) throw new Error(`cloud object identity mismatch: key says ${item.sessionId}, header says ${header.id}`)
  const sourceCwd = header.cwd ?? ''

  // 用户改选的落位路径：支持 ~ 与相对路径（相对本机 home），跨机恢复时
  // 用户心智是「home 下的 my-app」，两台机器 home 不同也不影响落位。
  const targetCwd = item.targetCwd !== null && item.targetCwd !== ''
    ? normalizeTargetCwd(item.targetCwd)
    : item.targetCwd

  // 路径归位：目标与来源不同才改写首帧 cwd，并学习实际使用的映射对（§4.3 步骤 4）。
  // 显式指定的目标目录必须先验证存在：写盘后失败无法回滚（同 id 重试会被拒绝覆盖）
  let locatedHeader: SessionHeaderLike = header
  if (targetCwd !== null && targetCwd !== sourceCwd) {
    if (sourceCwd === '') throw new Error('来源会话无 cwd，无法建立映射')
    if (!(await isExistingDirectory(targetCwd))) {
      throw new Error(`目标目录不存在或不是目录：${targetCwd}`)
    }
    plaintext = await rewriteCwd(plaintext, targetCwd)
    locatedHeader = { ...header, cwd: targetCwd }
    await learnMapping(deps.state, sourceCwd, targetCwd)
  }

  const location = deps.persistence.locate(locatedHeader)
  if (!location) throw new Error('persistence backend exposes no file artifact')

  // 本地已存在同 id 不允许覆盖（01 §5.4：想覆盖需先在 dsh 内删除本地会话）
  try {
    await fsp.stat(location.path)
    throw new Error('local session already exists at target')
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
  }

  await fsp.mkdir(path.dirname(location.path), { recursive: true })
  const tmp = `${location.path}.tmp-${process.pid}`
  await fsp.writeFile(tmp, plaintext)
  await fsp.rename(tmp, location.path)

  // workspace 挂载（web 侧边栏按成员关系分组）。目录存在的落位 cwd 才尝试挂载：
  // 原样落位到本机不存在的来源路径时按 §4.3 语义保持「未分组」，不算失败。
  // 挂载失败仅告警不回滚——文件已就位，会话至少出现在「未分组」桶，重试 attach
  // 也没有意义（同 cwd 再挂靠 registry 幂等，但失败原因通常是目录状态异常）
  const effectiveCwd = locatedHeader.cwd ?? ''
  if (deps.attachWorkspace && effectiveCwd !== '' && await isExistingDirectory(effectiveCwd)) {
    try {
      await deps.attachWorkspace(item.sessionId, effectiveCwd)
    } catch (error) {
      deps.onWarn?.(`workspace 挂载失败 ${item.sessionId}（会话已落位，将出现在未分组）：${String(error)}`)
    }
  }
  return location.path
}

async function isExistingDirectory(target: string): Promise<boolean> {
  try {
    return (await fsp.stat(target)).isDirectory()
  } catch {
    return false
  }
}

/**
 * 规范化用户改选的落位路径（§4.3）：`~` 展开到本机 home，相对路径按本机
 * home 解析（跨机恢复最常见的心智模型——「home 下的 my-app」在两台
 * 机器 home 不同的情况下仍落到各自 home 下）；绝对路径原样返回。
 */
export function normalizeTargetCwd(raw: string): string {
  const trimmed = raw.trim()
  if (trimmed === '' || trimmed === '~') return trimmed === '' ? '' : os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  if (path.isAbsolute(trimmed)) return trimmed
  return path.resolve(os.homedir(), trimmed)
}

/**
 * 恢复后抑制立刻回传（§4.5）：把刚落位的会话以当前 revision 记入 state，
 * 引擎下一轮 scan 不会把它当变更上传；待本机续写产生新 revision 后才作为
 * 本设备名下的独立对象全量首传（state 偏移为 0，链式段从头开始，meta 折叠
 * 也会从首帧重新累积，无需在这里预填 title/eventCount）。
 */
export async function markRestoredSynced(
  deps: Pick<RestoreDeps, 'persistence' | 'state'>,
  sessionIds: string[],
): Promise<void> {
  if (sessionIds.length === 0) return
  const wanted = new Set(sessionIds)
  const snapshots = await deps.persistence.listSnapshots()
  for (const snapshot of snapshots) {
    if (!wanted.has(snapshot.header.id)) continue
    await deps.state.putSession(snapshot.header.id, {
      uploadedBytes: 0,
      remoteBytes: 0,
      lastSegmentIndex: -1,
      lastTag: '',
      localRevision: snapshot.revision,
      restoredAt: Date.now(),
      eventCount: 0,
      updatedAt: 0,
      status: 'ok',
    })
  }
}

/** 启动检查（01 §5.5）：其他设备名下存在本地没有的会话数。 */
export async function countRemoteOnlySessions(deps: CatalogDeps, selfDevice: string): Promise<number> {
  const entries = await fetchCatalog(deps)
  return entries.filter((entry) => entry.device !== selfDevice && !entry.existsLocal).length
}
