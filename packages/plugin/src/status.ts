/**
 * 连通性检查（docs/01 §5.1）：测试连接按钮的后台逻辑。
 * 纯逻辑、deps 注入，与 cordis 解耦便于单测；不创建任何云端对象
 * （kdf 引导只在引擎启动路径，这里只读）。
 */
import { decodeKdfSidecar, decryptMeta, deriveKey } from './crypto/envelope.js'
import type { StatusError, StatusPhase } from './config.js'
import { ProtocolError, type SyncClient } from './sync/http-client.js'

export interface ConnectionCheckDeps {
  client: SyncClient
  /** 设备名（云端命名空间段） */
  device: string
  /** 当前配置的口令；云端为空时不会用到（全新部署只验证地址与令牌） */
  passphrase: string
}

export interface ConnectionCheckResult {
  phase: StatusPhase
  /** 本设备命名空间下的云端会话数（.meta.enc 对象数） */
  cloudCount: number
  error: StatusError
  errorDetail: string
}

function ok(cloudCount: number): ConnectionCheckResult {
  return { phase: 'connected', cloudCount, error: '', errorDetail: '' }
}

function fail(error: StatusError, errorDetail = '', cloudCount = 0): ConnectionCheckResult {
  return { phase: 'failed', cloudCount, error, errorDetail }
}

/** 网络/协议错误分类：401 令牌无效，403 用户名与令牌不配对，其余按不可达。 */
function classify(error: unknown, cloudCount = 0): ConnectionCheckResult {
  if (error instanceof ProtocolError) {
    if (error.status === 401) return fail('tokenInvalid', String(error.message), cloudCount)
    if (error.status === 403) return fail('userMismatch', String(error.message), cloudCount)
    return fail('unreachable', `HTTP ${error.status}: ${error.message}`, cloudCount)
  }
  return fail('unreachable', String(error), cloudCount)
}

export async function runConnectionCheck(deps: ConnectionCheckDeps): Promise<ConnectionCheckResult> {
  const { client, device } = deps

  // 1. 列表探测：通且鉴权过即说明地址与令牌有效
  let objects: Awaited<ReturnType<SyncClient['list']>>
  try {
    objects = await client.list(`sessions/${device}/`)
  } catch (error) {
    return classify(error)
  }

  // 2. 云端会话数 = 设备命名空间下的 meta 对象数
  const metas = objects.filter((o) => o.key.endsWith('.meta.enc'))
  const cloudCount = metas.length

  // 3. 云端非空时校验口令：kdf sidecar + 首个 meta 试解密
  if (cloudCount > 0) {
    let sidecar: Buffer
    try {
      sidecar = await client.download(`keys/${device}/kdf.json`)
    } catch (error) {
      // 会话存在但 kdf sidecar 缺失：无法派生密钥，按口令不匹配处理（只读，绝不创建）
      if (error instanceof ProtocolError && error.status === 404) {
        return fail('passphraseMismatch', `kdf sidecar 缺失（keys/${device}/kdf.json 404）`, cloudCount)
      }
      return classify(error, cloudCount)
    }
    try {
      const { salt, params } = decodeKdfSidecar(sidecar)
      const key = deriveKey(deps.passphrase, salt, params)
      const first = await client.download(metas[0].key)
      const sessionId = metas[0].key.slice(`sessions/${device}/`.length, -'.meta.enc'.length)
      decryptMeta(key, sessionId, first)
    } catch (error) {
      if (error instanceof ProtocolError) return classify(error, cloudCount)
      return fail('passphraseMismatch', String(error), cloudCount)
    }
  }

  return ok(cloudCount)
}
