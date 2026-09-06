/** 插件配置（docs/02 §9）。secret 字段经 wire 层强制 redact，响应永不回显。 */
import z from '@deepseek-ai/schemastery'

/** 连接状态相（schema 侧用 string，字面量联合仅供代码内使用）。 */
export type StatusPhase = 'unconfigured' | 'connected' | 'failed'

/** 状态错误码；'' 表示无错误。 */
export type StatusError = '' | 'unreachable' | 'tokenInvalid' | 'userMismatch' | 'passphraseMismatch' | 'deviceConflict' | 'syncFailed'

/**
 * 用户配置（'cloud-sync' namespace）：Host 永不写这个 namespace，
 * 用户配置写零冲突（Client 乐观锁 fence 不会被 Host 状态回写 bump 的 revision 撞掉）。
 */
export interface Config {
  serverUrl?: string
  username?: string
  token?: string
  passphrase?: string
  deviceName?: string
  autoUpload: boolean
  checkOnStartup: boolean
  uploadDebounceMs: number
  pollIntervalMs: number
  requestTimeoutMs: number
}

export const Config: z<Config> = z.object({
  serverUrl: z.string().description('云端服务地址，如 http://host:8787'),
  username: z.string().description('用户名（多用户服务端下发的账号名；单用户服务端留空）'),
  token: z.string().role('secret').description('Bearer 访问令牌'),
  passphrase: z.string().role('secret').description('端到端加密口令'),
  deviceName: z.string().description('设备名（云端命名空间段，默认主机名）'),
  autoUpload: z.boolean().default(true).description('自动上传会话到云端'),
  checkOnStartup: z.boolean().default(true).description('启动时检查云端增量'),
  uploadDebounceMs: z.number().step(1).min(100).default(3000).description('同会话变更合并窗口（毫秒）'),
  pollIntervalMs: z.number().step(1).min(1000).default(30000).description('兜底扫描间隔（毫秒）'),
  requestTimeoutMs: z.number().step(1).min(1000).default(15000).description('单请求超时（毫秒）'),
})

/**
 * Host↔Client 通道（'cloud-sync-status' namespace）：Host 回写状态字段 +
 * Client 写触发器字段。与用户配置分 namespace 放——Host 回写 bump 的 revision
 * 只会撞通道自己的 fence，不会吃掉用户配置写。
 */
export interface StatusConfig {
  // ---- Host 回写的状态字段（Client 从 settingsScope snapshot 读） ----
  statusPhase: string
  statusCloudCount: number
  statusLastSyncAt: number
  statusCheckedAt: number
  statusError: string
  statusErrorDetail: string
  tokenConfigured: boolean
  passphraseConfigured: boolean
  statusSyncAllAt: number
  statusSyncAllOk: number
  statusSyncAllFailed: number
  statusSyncAllError: string
  /** 恢复目录（JSON：{at, selfDevice, sessions, error}，at 回显 restoreListRequestedAt） */
  restoreCatalogJson: string
  /** 恢复结果（JSON：{at, ok, failed, firstError}，at 回显请求的 at） */
  restoreResultJson: string
  /** 已学习路径映射（JSON：[{from, to}]，设置卡「路径映射」区数据源） */
  pathMappingsJson: string
  /** 启动检查发现他机增量（JSON：{at, count}；'' 表示无通知） */
  startupNoticeJson: string
  // ---- Client 写入的触发器字段（Host 在 onChange 里消费） ----
  testRequestedAt: number
  syncAllRequestedAt: number
  restoreListRequestedAt: number
  /** 恢复请求（JSON：{at, items: [{sessionId, device, targetCwd}]}；'' 表示无请求） */
  restoreRequestJson: string
  /** 删除路径映射（JSON：{at, from}；'' 表示无请求） */
  mappingDeleteJson: string
}

export const StatusConfig: z<StatusConfig> = z.object({
  statusPhase: z.string().default('unconfigured').description('连接状态：unconfigured/connected/failed（Host 维护）'),
  statusCloudCount: z.number().default(0).description('本设备命名空间下的云端会话数（Host 维护）'),
  statusLastSyncAt: z.number().default(0).description('上次同步成功时间（epoch ms，Host 维护）'),
  statusCheckedAt: z.number().default(0).description('已消费的 testRequestedAt 回显（连通性检查完成信号）'),
  statusError: z.string().default('').description('状态错误码（Host 维护）'),
  statusErrorDetail: z.string().default('').description('错误详情：触发会话 id 或原始错误摘要（Host 维护）'),
  tokenConfigured: z.boolean().default(false).description('令牌已配置信号（secret 不下行，Host 维护）'),
  passphraseConfigured: z.boolean().default(false).description('口令已配置信号（secret 不下行，Host 维护）'),
  statusSyncAllAt: z.number().default(0).description('已消费的 syncAllRequestedAt 回显（全部同步完成信号）'),
  statusSyncAllOk: z.number().default(0).description('最近一次全部同步成功数（Host 维护）'),
  statusSyncAllFailed: z.number().default(0).description('最近一次全部同步失败数（Host 维护）'),
  statusSyncAllError: z.string().default('').description('最近一次全部同步的首个失败摘要（Host 维护）'),
  restoreCatalogJson: z.string().default('').description('恢复目录 JSON（Host 维护，at 回显 restoreListRequestedAt）'),
  restoreResultJson: z.string().default('').description('恢复结果 JSON（Host 维护，at 回显请求 at）'),
  pathMappingsJson: z.string().default('[]').description('已学习路径映射 JSON（Host 维护）'),
  startupNoticeJson: z.string().default('').description('启动检查增量通知 JSON（Host 维护）'),
  testRequestedAt: z.number().default(0).description('测试连接触发器（Client 写 Date.now()）'),
  syncAllRequestedAt: z.number().default(0).description('立即全部同步触发器（Client 写 Date.now()）'),
  restoreListRequestedAt: z.number().default(0).description('恢复目录拉取触发器（Client 写 Date.now()）'),
  restoreRequestJson: z.string().default('').description('恢复执行请求 JSON（Client 写，含 at 时间戳）'),
  mappingDeleteJson: z.string().default('').description('路径映射删除请求 JSON（Client 写，含 at 时间戳）'),
})

/** 通道字段默认值（installSection 的 base entry，须与 schema default 一致）。 */
export const INITIAL_STATUS: StatusConfig = {
  statusPhase: 'unconfigured',
  statusCloudCount: 0,
  statusLastSyncAt: 0,
  statusCheckedAt: 0,
  statusError: '',
  statusErrorDetail: '',
  tokenConfigured: false,
  passphraseConfigured: false,
  statusSyncAllAt: 0,
  statusSyncAllOk: 0,
  statusSyncAllFailed: 0,
  statusSyncAllError: '',
  restoreCatalogJson: '',
  restoreResultJson: '',
  pathMappingsJson: '[]',
  startupNoticeJson: '',
  testRequestedAt: 0,
  syncAllRequestedAt: 0,
  restoreListRequestedAt: 0,
  restoreRequestJson: '',
  mappingDeleteJson: '',
}
