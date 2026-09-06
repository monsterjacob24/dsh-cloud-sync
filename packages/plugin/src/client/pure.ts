/**
 * 设置卡纯函数层：字段校验、相对时间规格、状态行投影。
 * 只依赖入参，不触碰 React / DOM / settings scope，供 node:test 直接单测
 * （client 单测只测纯函数，不 import tsx 组件）。
 */

/** 服务器地址校验：空串视为「未填」（不算非法），非空必须是合法的 http(s) URL。 */
export function isValidServerUrl(text: string): boolean {
  if (text === '') return true
  let url: URL
  try {
    url = new URL(text)
  } catch {
    return false
  }
  return url.protocol === 'http:' || url.protocol === 'https:'
}

/** 设备名校验：空串 = 回退本机主机名；否则仅限 [a-zA-Z0-9-_]，长度 ≤ 32。 */
export function isValidDeviceName(text: string): boolean {
  return text === '' || /^[a-zA-Z0-9-_]{1,32}$/.test(text)
}

/** 相对时间文案规格：渲染层据 key（+ count）查字典，本层不出现任何文案。 */
export type RelativeTimeSpec =
  | { key: 'time.justNow' }
  | { key: 'time.minutesAgo' | 'time.hoursAgo' | 'time.daysAgo'; count: number }

const MINUTE_MS = 60_000
const HOUR_MS = 3_600_000
const DAY_MS = 86_400_000

/** 把 epoch 毫秒时间戳投影为相对时间规格；at <= 0（从未同步）返回 null（不显示该项）。 */
export function relativeTime(at: number, now: number): RelativeTimeSpec | null {
  if (at <= 0) return null
  const diff = Math.max(0, now - at)
  if (diff < MINUTE_MS) return { key: 'time.justNow' }
  if (diff < HOUR_MS) return { key: 'time.minutesAgo', count: Math.max(1, Math.round(diff / MINUTE_MS)) }
  if (diff < DAY_MS) return { key: 'time.hoursAgo', count: Math.max(1, Math.round(diff / HOUR_MS)) }
  return { key: 'time.daysAgo', count: Math.max(1, Math.round(diff / DAY_MS)) }
}

/** Host 写入的状态机相位（docs/02 §9 下半表）。 */
export type StatusPhase = 'unconfigured' | 'connected' | 'failed'

/** Host 写入的错误码；'' 表示无错误。 */
export type StatusError =
  '' | 'unreachable' | 'tokenInvalid' | 'userMismatch' | 'passphraseMismatch' | 'deviceConflict' | 'syncFailed'

/** 状态行投影入参。 */
export interface StatusLineInput {
  phase: StatusPhase
  error: StatusError
  errorDetail: string
  cloudCount: number
  lastSyncAt: number
  now: number
}

/** 状态行投影结果：渲染层按 kind 分支取文案，错误码经 errorKeyOf 映射字典 key。 */
export type StatusLine =
  | { kind: 'unconfigured' }
  | { kind: 'failed'; error: StatusError; detail: string }
  | {
    kind: 'connected'
    count: number
    lastSync: RelativeTimeSpec | null
    /** 连续推送失败 / 设备名冲突时前缀告警标记（01 §5.2、§6）。 */
    warn: boolean
    error: StatusError
    detail: string
  }

/** 把 Host 状态字段投影为一行式运行概况。 */
export function projectStatusLine(input: StatusLineInput): StatusLine {
  if (input.phase === 'unconfigured') return { kind: 'unconfigured' }
  if (input.phase === 'failed') return { kind: 'failed', error: input.error, detail: input.errorDetail }
  return {
    kind: 'connected',
    count: input.cloudCount,
    lastSync: relativeTime(input.lastSyncAt, input.now),
    warn: input.error === 'syncFailed' || input.error === 'deviceConflict',
    error: input.error,
    detail: input.errorDetail,
  }
}

/** 错误码 → 文案字典 key；空码与 syncFailed（failed 相位下的兜底）落到 error.unknown。 */
export function errorKeyOf(
  error: StatusError,
): 'error.unreachable' | 'error.tokenInvalid' | 'error.userMismatch' | 'error.passphraseMismatch' | 'error.deviceConflict' | 'error.unknown' {
  switch (error) {
    case 'unreachable': return 'error.unreachable'
    case 'tokenInvalid': return 'error.tokenInvalid'
    case 'userMismatch': return 'error.userMismatch'
    case 'passphraseMismatch': return 'error.passphraseMismatch'
    case 'deviceConflict': return 'error.deviceConflict'
    default: return 'error.unknown'
  }
}

/**
 * 测试连接 / 立即全部同步的可用性（01 §6）：地址已填且合法，且令牌可用
 * （已配置或本次新填了草稿）。
 */
export function canRunServerAction(serverUrlDraft: string, tokenAvailable: boolean): boolean {
  return serverUrlDraft !== '' && isValidServerUrl(serverUrlDraft) && tokenAvailable
}

/** 触发器写的重试节拍：1s 内没看到回显就重发。 */
export const TRIGGER_RETRY_MS = 1_000
/** 触发器写的总超时：20s 仍无回显则退出进行态。 */
export const TRIGGER_TIMEOUT_MS = 20_000

/**
 * 触发器写的下一步动作。
 *
 * 背景：SettingsScope.set 用「客户端已知最新 revision」做乐观锁 fence，冲突时
 * Host 返回 {ok:false}，client recover() 重载后写入被静默丢弃、Promise 正常
 * resolve。Host 高频回写 'cloud-sync-status' namespace，触发器写（
 * testRequestedAt/syncAllRequestedAt）可能撞 fence 被吃掉，因此对触发器写做
 * 「重试到回显」自愈：回显（statusCheckedAt/statusSyncAllAt >= issuedAt）本来
 * 就是完成信号。
 *
 * @param echoAt - 回显字段当前值（无则 0）。
 * @param issuedAt - 本次触发发出的时间戳（重试保持同一值，进行态判定不抖动）。
 * @param lastSentAt - 上一次实际写出的时刻。
 * @param now - 当前时刻。
 * @returns done（回显到达）/ timeout（总超时）/ resend（距上次写已满一个节拍）/ wait。
 */
export type TriggerAction = 'done' | 'timeout' | 'resend' | 'wait'
export function triggerAction(echoAt: number, issuedAt: number, lastSentAt: number, now: number): TriggerAction {
  // 回显优先于超时：迟到但完成的回显不能把一次成功判成失败
  if (echoAt >= issuedAt) return 'done'
  if (now - issuedAt >= TRIGGER_TIMEOUT_MS) return 'timeout'
  if (now - lastSentAt >= TRIGGER_RETRY_MS) return 'resend'
  return 'wait'
}

// ---- M4：恢复流程（通道 JSON 载荷的 Client 侧拼写，与 Host sync/restore.ts 分别维护） ----

/** 恢复目录的一行（Host 已计算好 existsLocal / 版本 / 路径解析，Client 只呈现与改选）。 */
export interface CatalogEntry {
  sessionId: string
  device: string
  title: string
  updatedAt: number
  eventCount: number
  cwd: string
  formatVersion: number
  existsLocal: boolean
  versionIncompatible: boolean
  resolvedCwd: string | null
  resolution: 'mapping' | 'suggested' | 'none'
}

/** restoreCatalogJson 的载荷（at 回显 restoreListRequestedAt）。 */
export interface RestoreCatalog {
  at: number
  selfDevice: string
  sessions: CatalogEntry[]
  error: string
}

/** restoreResultJson 的载荷（at 回显请求的 at）。 */
export interface RestoreResultPayload {
  at: number
  ok: number
  failed: number
  firstError: string
}

/** startupNoticeJson 的载荷（启动检查发现他机增量）。 */
export interface StartupNoticePayload {
  at: number
  count: number
}

/** pathMappingsJson 的元素（设置卡「路径映射」区）。 */
export interface MappingPair {
  from: string
  to: string
}

/** 防御性解析：通道字段可能被旧版本/手工编辑污染，任何不符都按无数据处理。 */
export function parseCatalog(raw: string): RestoreCatalog | null {
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw) as RestoreCatalog
    if (typeof parsed.at !== 'number' || !Array.isArray(parsed.sessions) || typeof parsed.selfDevice !== 'string') return null
    return parsed
  } catch {
    return null
  }
}

export function parseRestoreResult(raw: string): RestoreResultPayload | null {
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw) as RestoreResultPayload
    if (typeof parsed.at !== 'number' || typeof parsed.ok !== 'number' || typeof parsed.failed !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

export function parseMappings(raw: string): MappingPair[] {
  if (raw === '') return []
  try {
    const parsed = JSON.parse(raw) as MappingPair[]
    if (!Array.isArray(parsed)) return []
    return parsed.filter((pair) => typeof pair?.from === 'string' && typeof pair?.to === 'string')
  } catch {
    return []
  }
}

export function parseStartupNotice(raw: string): StartupNoticePayload | null {
  if (raw === '') return null
  try {
    const parsed = JSON.parse(raw) as StartupNoticePayload
    if (typeof parsed.at !== 'number' || typeof parsed.count !== 'number' || parsed.at <= 0) return null
    return parsed
  } catch {
    return null
  }
}

/** 恢复请求（Client→Host）：每行 targetCwd 为 null 表示原样落位（恢复后未分组）。 */
export function encodeRestoreRequest(
  at: number,
  items: { sessionId: string; device: string; targetCwd: string | null }[],
): string {
  return JSON.stringify({ at, items })
}

/** 路径映射删除请求（Client→Host）。 */
export function encodeMappingDelete(at: number, from: string): string {
  return JSON.stringify({ at, from })
}

/** 行主键：设备 + 会话 id（同 id 跨设备是两行）。 */
export function rowKeyOf(entry: Pick<CatalogEntry, 'device' | 'sessionId'>): string {
  return `${entry.device}/${entry.sessionId}`
}

/** 行可恢复性：本地已存在 / 版本不兼容的行禁用（01 §5.4）。 */
export function isRowRestorable(entry: Pick<CatalogEntry, 'existsLocal' | 'versionIncompatible'>): boolean {
  return !entry.existsLocal && !entry.versionIncompatible
}

/** 默认勾选：当前设备之外、且可恢复的会话（01 §5.4）。 */
export function defaultSelectedKeys(catalog: RestoreCatalog): string[] {
  return catalog.sessions
    .filter((entry) => entry.device !== catalog.selfDevice && isRowRestorable(entry))
    .map(rowKeyOf)
}

/** 来源设备筛选选项（目录内出现过的设备，按字典序稳定）。 */
export function deviceOptions(catalog: RestoreCatalog): string[] {
  return [...new Set(catalog.sessions.map((entry) => entry.device))].sort()
}

/** 按来源设备筛选；空 filter 表示全部。 */
export function filterEntries(entries: CatalogEntry[], filter: string): CatalogEntry[] {
  if (filter === '') return entries
  return entries.filter((entry) => entry.device === filter)
}

/** 目录拉取/恢复执行失败的错误码 → 文案字典 key（复用状态行错误文案，加 unconfigured）。 */
export function catalogErrorKeyOf(
  error: string,
): 'status.unconfigured' | 'error.unreachable' | 'error.tokenInvalid' | 'error.userMismatch' {
  if (error === 'tokenInvalid') return 'error.tokenInvalid'
  if (error === 'userMismatch') return 'error.userMismatch'
  if (error === 'unconfigured') return 'status.unconfigured'
  return 'error.unreachable'
}
