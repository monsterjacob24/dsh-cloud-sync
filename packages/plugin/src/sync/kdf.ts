/**
 * kdf 引导（docs/03 §5.1）：解析本机派生参数，并支持跨设备发现。
 *
 * 解析顺序：
 * 1. 本机名下 sidecar（keys/<device>/kdf.json）存在 → 直接使用；
 * 2. 缺失 → 拉取 keys/ 下他机 sidecar 逐个试派生：任一云端 meta 对象能用
 *    该密钥解开即验证通过，采纳该 sidecar（镜像写回本机名下，后续启动直连）；
 * 3. 他机 sidecar 存在但云端没有任何 meta（尚无会话，无从验证）→ 采纳首个
 *    候选——口令不符也无害（没有对象需要解开），口令相符则免去镜像步骤；
 * 4. 全部验证失败或云端没有 sidecar → 生成新 salt 上传本机名下。
 *
 * 与 cordis 解耦，deps 注入便于单测。
 */
import { decodeKdfSidecar, decryptMeta, deriveKey, encodeKdfSidecar, generateSalt, KDF_DEFAULTS, type KdfParams } from '../crypto/envelope.js'
import { ProtocolError, type SyncClient } from './http-client.js'

/** 验证口令时最多尝试解密的 meta 对象数（多云端口令并存时避免整表扫描）。 */
const VERIFY_META_LIMIT = 5

export interface KdfDeps {
  client: SyncClient
  device: string
  passphrase: string
  /** 采纳他机 sidecar 时回调（日志/状态行提示） */
  onAdopt?: (message: string) => void
}

export interface KdfKey {
  key: Buffer
  salt: Buffer
}

function ownKey(device: string): string {
  return `keys/${device}/kdf.json`
}

function isNotFound(error: unknown): boolean {
  return error instanceof ProtocolError && error.status === 404
}

/** 云端全部 meta 对象的 key（sessions/<device>/<id>.meta.enc）。 */
async function listMetaKeys(client: SyncClient): Promise<string[]> {
  const objects = await client.list('sessions/')
  return objects.filter((object) => object.key.endsWith('.meta.enc')).map((object) => object.key)
}

/** 用候选密钥试解任一 meta 对象：解开即口令匹配。 */
async function verifyKey(client: SyncClient, key: Buffer, metaKeys: readonly string[]): Promise<boolean> {
  for (const metaKey of metaKeys.slice(0, VERIFY_META_LIMIT)) {
    try {
      const bytes = await client.download(metaKey)
      const sessionId = metaKey.split('/').at(-1)!.slice(0, -'.meta.enc'.length)
      decryptMeta(key, sessionId, bytes)
      return true
    } catch (error) {
      if (error instanceof ProtocolError && error.status !== 404) throw error
      // 解密失败（口令不符）或对象恰好被删（404）：换下一个 meta 继续
    }
  }
  return false
}

/** kdf 引导（见模块注释的解析顺序）。 */
export async function bootstrapKdf(deps: KdfDeps): Promise<KdfKey> {
  const { client, device, passphrase } = deps

  // 1. 本机 sidecar
  const own = ownKey(device)
  try {
    const { salt, params } = decodeKdfSidecar(await client.download(own))
    return { key: deriveKey(passphrase, salt, params), salt }
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  // 2/3. 他机 sidecar 逐个试派生
  let candidates: { key: string; bytes: Buffer }[] = []
  try {
    const objects = await client.list('keys/')
    const foreignKeys = objects.map((object) => object.key).filter((key) => key.endsWith('/kdf.json') && key !== own)
    candidates = await Promise.all(foreignKeys.map(async (key) => ({ key, bytes: await client.download(key) })))
  } catch (error) {
    if (!isNotFound(error)) throw error
  }

  if (candidates.length > 0) {
    let metaKeys: string[] = []
    try {
      metaKeys = await listMetaKeys(client)
    } catch {
      // 列表失败按无可验证对象处理（下方采纳语义不受影响）
    }
    for (const candidate of candidates) {
      let salt: Buffer
      let params: KdfParams
      try {
        ;({ salt, params } = decodeKdfSidecar(candidate.bytes))
      } catch {
        continue // 损坏的 sidecar：跳过换下一个
      }
      const derived = deriveKey(passphrase, salt, params)
      if (metaKeys.length === 0 || await verifyKey(client, derived, metaKeys)) {
        // 采纳：镜像写回本机名下，后续启动直连本机 sidecar
        await client.overwrite(own, candidate.bytes)
        deps.onAdopt?.(`已采纳 ${candidate.key} 的派生参数（口令校验${metaKeys.length === 0 ? '跳过：云端尚无会话' : '通过'}）`)
        return { key: derived, salt }
      }
    }
  }

  // 4. 全部未命中：生成新 salt 上传本机名下
  const params = KDF_DEFAULTS
  const salt = generateSalt()
  await client.overwrite(own, encodeKdfSidecar(salt, params))
  return { key: deriveKey(passphrase, salt, params), salt }
}
