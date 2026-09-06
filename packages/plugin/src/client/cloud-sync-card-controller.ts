/**
 * 云端同步设置卡 controller：桥接两个 settings namespace 与卡片快照。
 *
 * 双 namespace 拆分（Host 半契约）：
 * - 'cloud-sync'：9 个用户配置字段，Host 永不写 → 配置写零 revision 冲突，
 *   scope.set/unset 的乐观锁 fence 永远新鲜，无需重试。
 * - 'cloud-sync-status'：14 个通道字段（状态回读 + 触发器），Host 频繁回写。
 *   触发器写（testRequestedAt/syncAllRequestedAt）可能撞 fence 被静默丢弃
 *   （冲突时 client recover() 重载、Promise 正常 resolve），因此触发器写做
 *   「重试到回显」自愈，见 pure.ts 的 triggerAction。
 *
 * secret 字段（token/passphrase）永不下行，卡片只凭 Host 维护的
 * tokenConfigured/passphraseConfigured 布尔显示「已配置/未配置」，输入框永远空值起手。
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { SettingsScope } from '@deepseek-ai/dsh-client-ui-settings/client'
import {
  canRunServerAction,
  defaultSelectedKeys,
  encodeMappingDelete,
  encodeRestoreRequest,
  isRowRestorable,
  isValidDeviceName,
  isValidServerUrl,
  parseCatalog,
  parseMappings,
  parseRestoreResult,
  parseStartupNotice,
  projectStatusLine,
  rowKeyOf,
  triggerAction,
  TRIGGER_RETRY_MS,
  type MappingPair,
  type RestoreCatalog,
  type RestoreResultPayload,
  type StartupNoticePayload,
  type StatusError,
  type StatusLine,
  type StatusPhase,
} from './pure.ts'

/** 用户配置 namespace（与 Host 半约定一致，两处分别拼写，不跨半 import）。 */
export const CLOUD_SYNC_NS = 'cloud-sync'
/** 状态/触发通道 namespace（Host 高频回写）。 */
export const CLOUD_SYNC_STATUS_NS = 'cloud-sync-status'

/** 'cloud-sync' namespace 的用户配置字段（Host 永不写）。 */
export interface CloudSyncConfig {
  serverUrl?: string
  username?: string
  deviceName?: string
  autoUpload?: boolean
  checkOnStartup?: boolean
  uploadDebounceMs?: number
  pollIntervalMs?: number
  requestTimeoutMs?: number
}

/** 'cloud-sync-status' namespace 的通道字段：状态回读 + 触发器。 */
export interface CloudSyncStatus {
  statusPhase?: StatusPhase
  statusCloudCount?: number
  statusLastSyncAt?: number
  statusCheckedAt?: number
  statusError?: StatusError
  statusErrorDetail?: string
  tokenConfigured?: boolean
  passphraseConfigured?: boolean
  statusSyncAllAt?: number
  statusSyncAllOk?: number
  statusSyncAllFailed?: number
  statusSyncAllError?: string
  testRequestedAt?: number
  syncAllRequestedAt?: number
  /** M4：Host 回写的恢复目录 / 结果 / 映射列表 / 启动通知（JSON 字符串）。 */
  restoreCatalogJson?: string
  restoreResultJson?: string
  pathMappingsJson?: string
  startupNoticeJson?: string
  /** M4：Client 写入的触发器。 */
  restoreListRequestedAt?: number
  restoreRequestJson?: string
  mappingDeleteJson?: string
}

/** 目录选择器能力（ctx.remote.directoryPicker 的最小切面；能力缺失时降级手动输入）。 */
export interface DirectoryPickerLike {
  pick(): Promise<{ ok: true; value: string | null } | { ok: false; error: { message: string } }>
}

/** 一次「立即全部同步」的结果摘要（短暂显示后自动消失）。 */
export interface SyncAllResult {
  ok: number
  failed: number
  /** 首个失败摘要（Host 原文，数据而非文案）。 */
  error: string
}

/** 卡片渲染所需的全部状态。 */
export interface CloudSyncCardState {
  /** 配置 namespace 不可用（Host 未 serve）时卡片整体不渲染。 */
  available: boolean
  /** Host 文档是否可写（memory 模式只读，全部控件禁用）。 */
  writable: boolean
  serverUrlDraft: string
  /** 草稿非空且非合法 http(s) URL：就地报错并禁用测试连接。 */
  serverUrlInvalid: boolean
  usernameDraft: string
  deviceNameDraft: string
  deviceNameInvalid: boolean
  /** 永远空值起手；提交后即清空。 */
  tokenDraft: string
  passphraseDraft: string
  tokenConfigured: boolean
  passphraseConfigured: boolean
  autoUpload: boolean
  checkOnStartup: boolean
  /** 不含进行态的可用性；按钮 disabled 还需叠加 testPending/syncPending。 */
  canTest: boolean
  canSync: boolean
  testPending: boolean
  syncPending: boolean
  statusLine: StatusLine
  syncResult: SyncAllResult | null
  // ---- M4：恢复对话框 / 路径映射 / 启动通知 ----
  /** 恢复对话框开关（对话框挂在 shell.overlay，设置页外也能开）。 */
  restoreOpen: boolean
  /** 最近一次目录拉取结果；null = 从未拉取。 */
  catalog: RestoreCatalog | null
  catalogPending: boolean
  restorePending: boolean
  /** 恢复完成的结果摘要（overlay toast 展示，短暂停留）。 */
  restoreOutcome: RestoreResultPayload | null
  deviceFilter: string
  /** 勾选的行主键（device/sessionId）。 */
  selectedKeys: string[]
  /** 用户改选的落位路径（行主键 → 本机目录）。 */
  overrides: Record<string, string>
  /** 已学习路径映射（设置卡只读列表）。 */
  mappings: MappingPair[]
  /** 启动检查通知（null = 无/已忽略）。 */
  notice: StartupNoticePayload | null
  /** 目录选择器能力可用性（不可用时行内降级为手动输入）。 */
  pickerAvailable: boolean
}

/** 注册侧 face：hooks 由渲染器绑定为组件 props 上的 useCloudSyncCard。 */
export interface CloudSyncCardFace {
  hooks: {
    /** 卡片快照，渲染器绑定为 useCloudSyncCard(selector)。 */
    cloudSyncCard: SnapshotStore<CloudSyncCardState>
  }
  editServerUrl(text: string): void
  commitServerUrl(): void
  editUsername(text: string): void
  commitUsername(): void
  editToken(text: string): void
  commitToken(): void
  editPassphrase(text: string): void
  commitPassphrase(): void
  editDeviceName(text: string): void
  commitDeviceName(): void
  toggleAutoUpload(): void
  toggleCheckOnStartup(): void
  testConnection(): void
  syncAll(): void
  // ---- M4：恢复对话框 / 路径映射 / 启动通知 ----
  openRestore(): void
  closeRestore(): void
  setDeviceFilter(filter: string): void
  toggleRow(key: string): void
  /** 目录选择器改选（能力不可用时 UI 不渲染该按钮，走 overrideTarget 手动输入）。 */
  pickTarget(key: string): void
  /** 手动输入改选（受控输入逐键更新；空串 = 清除改选）。 */
  overrideTarget(key: string, text: string): void
  restoreSelected(): void
  deleteMapping(from: string): void
  dismissNotice(): void
  /** toast 的「点击查看」：关掉通知并打开恢复对话框。 */
  viewNotice(): void
  clearRestoreOutcome(): void
}

/** 同步结果摘要的停留时长。 */
const SYNC_RESULT_VISIBLE_MS = 8_000
/** 相对时间（"N 分钟前"）的静默刷新节拍。 */
const CLOCK_TICK_MS = 30_000
/** 启动通知已读标记的 sessionStorage key。 */
const NOTICE_SEEN_KEY = 'dsh-cloud-sync:notice-seen-at'

/** 一次进行中的触发器写。 */
interface PendingOp {
  /** 本次触发发出的时间戳；重试保持同一值，回显 >= 它即完成。 */
  issuedAt: number
  /** 上一次实际写出的时刻（距它满 TRIGGER_RETRY_MS 且无回显则重发）。 */
  lastSentAt: number
}

/** 桥接两个 SettingsScope 与卡片快照。 */
export class CloudSyncCardController {
  private readonly store: SnapshotStore<CloudSyncCardState>
  /** 本地草稿 + 各草稿对应的 scope 已同步值（用于识别外部变更该否覆盖草稿）。 */
  private serverUrlDraft = ''
  private serverUrlSynced = ''
  private usernameDraft = ''
  private usernameSynced = ''
  private deviceNameDraft = ''
  private deviceNameSynced = ''
  private tokenDraft = ''
  private passphraseDraft = ''
  /** 本次会话内 secret 提交过的乐观标记（Host 的 tokenConfigured 回写前的即时反馈） */
  private tokenCommitted = false
  private passphraseCommitted = false
  private now = Date.now()
  private pendingTest: PendingOp | null = null
  private pendingSync: PendingOp | null = null
  private syncResult: SyncAllResult | null = null
  private syncResultTimer: ReturnType<typeof setTimeout> | null = null
  /** 触发器进行期间的 1s 驱动节拍（无 pending 时停掉，不白转）。 */
  private triggerWatch: ReturnType<typeof setInterval> | null = null
  private readonly disposers: (() => void)[] = []
  // ---- M4 内部状态 ----
  private restoreOpen = false
  private catalog: RestoreCatalog | null = null
  private pendingRestoreList: PendingOp | null = null
  private pendingRestore: PendingOp | null = null
  private restoreOutcome: RestoreResultPayload | null = null
  private deviceFilter = ''
  private readonly selectedKeys = new Set<string>()
  private readonly overrides = new Map<string, string>()
  /** 映射删除的进行中请求（回显 = pathMappingsJson 里不再有该 from）。 */
  private pendingMappingDelete: (PendingOp & { from: string }) | null = null
  /** 启动通知的已读标记（同 at 不重复弹；sessionStorage 记忆，跨页面刷新不重现）。 */
  private noticeSeenAt = 0

  /**
   * @param configScope - 绑定 'cloud-sync' 的 scope（配置读写）。
   * @param statusScope - 绑定 'cloud-sync-status' 的 scope（状态读 + 触发器写）。
   * @param directoryPicker - 目录选择器能力（可选；缺失时恢复对话框降级为手动输入）。
   */
  constructor(
    private readonly configScope: SettingsScope<CloudSyncConfig>,
    private readonly statusScope: SettingsScope<CloudSyncStatus>,
    private readonly directoryPicker?: DirectoryPickerLike,
  ) {
    this.store = createSnapshotStore(this.projection())
    this.disposers.push(this.configScope.subscribe(() => { this.onConfigChange() }))
    this.disposers.push(this.statusScope.subscribe(() => { this.onStatusChange() }))
    const clock = setInterval(() => {
      this.now = Date.now()
      this.reproject()
    }, CLOCK_TICK_MS)
    this.disposers.push(() => { clearInterval(clock) })
    try {
      this.noticeSeenAt = Number(globalThis.sessionStorage?.getItem(NOTICE_SEEN_KEY) ?? 0) || 0
    } catch {
      // sessionStorage 不可用（隐私模式等）：退化为每次页面加载最多弹一次
    }
    this.onConfigChange()
    this.onStatusChange()
  }

  /** 释放订阅与计时器（插件卸载时由 ctx.effect 的清理函数调用）。 */
  dispose(): void {
    for (const dispose of this.disposers.splice(0)) dispose()
    if (this.triggerWatch !== null) clearInterval(this.triggerWatch)
    if (this.syncResultTimer !== null) clearTimeout(this.syncResultTimer)
  }

  /** 构建注册侧 face。 */
  inject(): CloudSyncCardFace {
    return {
      hooks: { cloudSyncCard: this.store },
      editServerUrl: (text) => {
        this.serverUrlDraft = text
        this.reproject()
      },
      commitServerUrl: () => { this.commitServerUrl() },
      editUsername: (text) => {
        this.usernameDraft = text
        this.reproject()
      },
      commitUsername: () => { this.commitUsername() },
      editToken: (text) => {
        this.tokenDraft = text
        this.reproject()
      },
      commitToken: () => { this.commitSecret('token') },
      editPassphrase: (text) => {
        this.passphraseDraft = text
        this.reproject()
      },
      commitPassphrase: () => { this.commitSecret('passphrase') },
      editDeviceName: (text) => {
        this.deviceNameDraft = text
        this.reproject()
      },
      commitDeviceName: () => { this.commitDeviceName() },
      toggleAutoUpload: () => { this.toggleBoolean('autoUpload') },
      toggleCheckOnStartup: () => { this.toggleBoolean('checkOnStartup') },
      testConnection: () => { this.startTrigger('test') },
      syncAll: () => { this.startTrigger('sync') },
      openRestore: () => { this.openRestore() },
      closeRestore: () => {
        this.restoreOpen = false
        this.reproject()
      },
      setDeviceFilter: (filter) => {
        this.deviceFilter = filter
        this.reproject()
      },
      toggleRow: (key) => {
        if (this.selectedKeys.has(key)) this.selectedKeys.delete(key)
        else this.selectedKeys.add(key)
        this.reproject()
      },
      pickTarget: (key) => { void this.pickTarget(key) },
      overrideTarget: (key, text) => {
        const trimmed = text.trim()
        if (trimmed === '') this.overrides.delete(key)
        else this.overrides.set(key, trimmed)
        this.reproject()
      },
      restoreSelected: () => { this.startRestore() },
      deleteMapping: (from) => { this.startMappingDelete(from) },
      dismissNotice: () => { this.markNoticeSeen() },
      viewNotice: () => {
        this.markNoticeSeen()
        this.openRestore()
      },
      clearRestoreOutcome: () => {
        this.restoreOutcome = null
        this.reproject()
      },
    }
  }

  /** 配置 scope 变更：同步未修改的草稿（正在编辑的草稿不被外部变更覆盖）。 */
  private onConfigChange(): void {
    const value = this.configScope.getSnapshot().value
    const serverUrl = value?.serverUrl ?? ''
    if (this.serverUrlDraft === this.serverUrlSynced) this.serverUrlDraft = serverUrl
    this.serverUrlSynced = serverUrl
    const username = value?.username ?? ''
    if (this.usernameDraft === this.usernameSynced) this.usernameDraft = username
    this.usernameSynced = username
    const deviceName = value?.deviceName ?? ''
    if (this.deviceNameDraft === this.deviceNameSynced) this.deviceNameDraft = deviceName
    this.deviceNameSynced = deviceName
    this.reproject()
  }

  /** 状态 scope 变更：驱动触发器的完成/重试判定，再重投影。 */
  private onStatusChange(): void {
    // 目录兜底：采用通道里残留的上次结果（打开对话框即触发新拉取覆盖它），
    // 让 restoreItems 与渲染共用同一份数据
    if (this.catalog === null) {
      this.catalog = parseCatalog(this.statusScope.getSnapshot().value?.restoreCatalogJson ?? '')
    }
    this.driveTriggers()
    this.reproject()
  }

  /** 发起一次触发器写（测试连接 / 立即全部同步），进行态由 driveTriggers 维护。 */
  private startTrigger(kind: 'test' | 'sync'): void {
    if (kind === 'test' ? this.pendingTest !== null : this.pendingSync !== null) return
    const issuedAt = Date.now()
    const op: PendingOp = { issuedAt, lastSentAt: 0 }
    if (kind === 'test') this.pendingTest = op
    else this.pendingSync = op
    // 立即首发；后续重试由 triggerWatch 节拍驱动
    this.sendTrigger(op, kind === 'test' ? 'testRequestedAt' : 'syncAllRequestedAt')
    this.ensureTriggerWatch()
    this.reproject()
  }

  /** 写一次触发字段；失败不重抛——重试节拍会补发，总超时兜底退出。 */
  private sendTrigger(op: PendingOp, field: 'testRequestedAt' | 'syncAllRequestedAt'): void {
    op.lastSentAt = Date.now()
    void this.statusScope.set(field, op.issuedAt).catch(() => {})
  }

  /** 触发器驱动：对每个 pending 判定 done/timeout/resend/wait 并执行。 */
  private driveTriggers(): void {
    if (this.pendingTest === null && this.pendingSync === null
      && this.pendingRestoreList === null && this.pendingRestore === null && this.pendingMappingDelete === null) {
      this.maybeStopTriggerWatch()
      return
    }
    const now = Date.now()
    this.now = now
    const value = this.statusScope.getSnapshot().value
    if (this.pendingTest !== null) {
      const action = triggerAction(value?.statusCheckedAt ?? 0, this.pendingTest.issuedAt, this.pendingTest.lastSentAt, now)
      if (action === 'done' || action === 'timeout') this.pendingTest = null
      else if (action === 'resend') this.sendTrigger(this.pendingTest, 'testRequestedAt')
    }
    if (this.pendingSync !== null) {
      const op = this.pendingSync
      const action = triggerAction(value?.statusSyncAllAt ?? 0, op.issuedAt, op.lastSentAt, now)
      if (action === 'done') {
        this.pendingSync = null
        this.showSyncResult({
          ok: value?.statusSyncAllOk ?? 0,
          failed: value?.statusSyncAllFailed ?? 0,
          error: value?.statusSyncAllError ?? '',
        })
      } else if (action === 'timeout') {
        this.pendingSync = null
      } else if (action === 'resend') {
        this.sendTrigger(op, 'syncAllRequestedAt')
      }
    }
    if (this.pendingRestoreList !== null) {
      const op = this.pendingRestoreList
      const catalog = parseCatalog(value?.restoreCatalogJson ?? '')
      const action = triggerAction(catalog?.at ?? 0, op.issuedAt, op.lastSentAt, now)
      if (action === 'done') {
        this.pendingRestoreList = null
        this.catalog = catalog
        // 目录刷新后按当前设备重估默认勾选（保留用户已勾的行）
        if (catalog !== null) {
          for (const key of defaultSelectedKeys(catalog)) this.selectedKeys.add(key)
          // 目录里消失的行（他机删除等）从勾选与改选中清掉
          const live = new Set(catalog.sessions.map(rowKeyOf))
          for (const key of [...this.selectedKeys]) if (!live.has(key)) this.selectedKeys.delete(key)
          for (const key of [...this.overrides.keys()]) if (!live.has(key)) this.overrides.delete(key)
        }
      } else if (action === 'timeout') {
        this.pendingRestoreList = null
      } else if (action === 'resend') {
        op.lastSentAt = now
        void this.statusScope.set('restoreListRequestedAt', op.issuedAt).catch(() => {})
      }
    }
    if (this.pendingRestore !== null) {
      const op = this.pendingRestore
      const result = parseRestoreResult(value?.restoreResultJson ?? '')
      const action = triggerAction(result?.at ?? 0, op.issuedAt, op.lastSentAt, now)
      if (action === 'done' || action === 'timeout') {
        this.pendingRestore = null
        if (action === 'done' && result !== null) {
          this.restoreOutcome = result
          // 恢复完成 → 对话框关闭（01 §5.4），勾选与改选随本轮结束清空
          this.restoreOpen = false
          this.selectedKeys.clear()
          this.overrides.clear()
        }
      } else if (action === 'resend') {
        op.lastSentAt = now
        void this.statusScope.set('restoreRequestJson', encodeRestoreRequest(op.issuedAt, this.restoreItems())).catch(() => {})
      }
    }
    if (this.pendingMappingDelete !== null) {
      const op = this.pendingMappingDelete
      const gone = !parseMappings(value?.pathMappingsJson ?? '[]').some((pair) => pair.from === op.from)
      // 回显语义不是时间戳而是「该 from 已从映射列表消失」；echoAt 合成以复用 triggerAction
      const action = gone ? 'done' : triggerAction(0, op.issuedAt, op.lastSentAt, now)
      if (action === 'done' || action === 'timeout') this.pendingMappingDelete = null
      else if (action === 'resend') {
        op.lastSentAt = now
        void this.statusScope.set('mappingDeleteJson', encodeMappingDelete(op.issuedAt, op.from)).catch(() => {})
      }
    }
    this.maybeStopTriggerWatch()
    this.reproject()
  }

  /** pending 出现时起 1s 驱动节拍（写被静默丢弃时没有任何事件可等，必须主动轮询）。 */
  private ensureTriggerWatch(): void {
    if (this.triggerWatch !== null) return
    this.triggerWatch = setInterval(() => { this.driveTriggers() }, TRIGGER_RETRY_MS)
  }

  private maybeStopTriggerWatch(): void {
    if (this.pendingTest !== null || this.pendingSync !== null
      || this.pendingRestoreList !== null || this.pendingRestore !== null || this.pendingMappingDelete !== null) return
    if (this.triggerWatch === null) return
    clearInterval(this.triggerWatch)
    this.triggerWatch = null
  }

  // ---- M4 动作 ----

  /** 打开恢复对话框并发起目录拉取（每次打开都重新拉，保证 existsLocal 等标注新鲜）。 */
  private openRestore(): void {
    this.restoreOpen = true
    if (this.pendingRestoreList === null) {
      const op: PendingOp = { issuedAt: Date.now(), lastSentAt: 0 }
      this.pendingRestoreList = op
      op.lastSentAt = op.issuedAt
      void this.statusScope.set('restoreListRequestedAt', op.issuedAt).catch(() => {})
      this.ensureTriggerWatch()
    }
    this.reproject()
  }

  /** 目录选择器改选一行落位路径。 */
  private async pickTarget(key: string): Promise<void> {
    if (!this.directoryPicker) return
    try {
      const result = await this.directoryPicker.pick()
      if (result.ok && result.value !== null) {
        this.overrides.set(key, result.value)
        this.reproject()
      }
    } catch (error) {
      console.warn('cloud-sync: directory pick failed:', error)
    }
  }

  /** 组装恢复请求条目：改选优先，其次 Host 解析结果，都没有则 null（原样落位）。 */
  private restoreItems(): { sessionId: string; device: string; targetCwd: string | null }[] {
    const catalog = this.catalog
    if (catalog === null) return []
    const items: { sessionId: string; device: string; targetCwd: string | null }[] = []
    for (const entry of catalog.sessions) {
      const key = rowKeyOf(entry)
      if (!this.selectedKeys.has(key) || !isRowRestorable(entry)) continue
      items.push({
        sessionId: entry.sessionId,
        device: entry.device,
        targetCwd: this.overrides.get(key) ?? entry.resolvedCwd,
      })
    }
    return items
  }

  /** 发起恢复执行触发器（重试保持同一 at 与条目集）。 */
  private startRestore(): void {
    if (this.pendingRestore !== null) return
    const items = this.restoreItems()
    if (items.length === 0) return
    const op: PendingOp = { issuedAt: Date.now(), lastSentAt: 0 }
    this.pendingRestore = op
    op.lastSentAt = op.issuedAt
    void this.statusScope.set('restoreRequestJson', encodeRestoreRequest(op.issuedAt, items)).catch(() => {})
    this.ensureTriggerWatch()
    this.reproject()
  }

  /** 删除一条已学习映射（乐观移除 + 触发器重试到 Host 回显消失）。 */
  private startMappingDelete(from: string): void {
    if (this.pendingMappingDelete !== null) return
    const op: PendingOp & { from: string } = { issuedAt: Date.now(), lastSentAt: 0, from }
    this.pendingMappingDelete = op
    op.lastSentAt = op.issuedAt
    void this.statusScope.set('mappingDeleteJson', encodeMappingDelete(op.issuedAt, from)).catch(() => {})
    this.ensureTriggerWatch()
    this.reproject()
  }

  /** 启动通知已读：本次 at 记入 sessionStorage，同 at 不再弹（01 §5.5 不重复弹出）。 */
  private markNoticeSeen(): void {
    const notice = parseStartupNotice(this.statusScope.getSnapshot().value?.startupNoticeJson ?? '')
    if (notice !== null) {
      this.noticeSeenAt = notice.at
      try {
        globalThis.sessionStorage?.setItem(NOTICE_SEEN_KEY, String(notice.at))
      } catch {
        // sessionStorage 不可用时仅本次页面生命周期内有效
      }
    }
    this.reproject()
  }

  /** 展示同步结果摘要，短暂停留后自动消失。 */
  private showSyncResult(result: SyncAllResult): void {
    this.syncResult = result
    if (this.syncResultTimer !== null) clearTimeout(this.syncResultTimer)
    this.syncResultTimer = setTimeout(() => {
      this.syncResult = null
      this.syncResultTimer = null
      this.reproject()
    }, SYNC_RESULT_VISIBLE_MS)
  }

  /** 服务器地址提交（blur/Enter）：非法值不落盘，就地报错交给投影。 */
  private commitServerUrl(): void {
    const text = this.serverUrlDraft.trim()
    this.serverUrlDraft = text
    if (text !== '' && !isValidServerUrl(text)) {
      this.reproject()
      return
    }
    if (text === this.serverUrlSynced) return
    this.serverUrlSynced = text
    void this.configScope.set('serverUrl', text).catch(() => {})
  }

  /** 用户名提交（blur/Enter）：trim 后落盘，不做格式校验——合法性由服务端
   *  配对校验裁决（403 → userMismatch），插件无从感知服务端是单用户还是多用户。 */
  private commitUsername(): void {
    const text = this.usernameDraft.trim()
    this.usernameDraft = text
    if (text === this.usernameSynced) return
    this.usernameSynced = text
    void this.configScope.set('username', text).catch(() => {})
  }

  /** 设备名提交：合法或空（= 回退主机名）才落盘。 */
  private commitDeviceName(): void {
    const text = this.deviceNameDraft.trim()
    this.deviceNameDraft = text
    if (!isValidDeviceName(text)) {
      this.reproject()
      return
    }
    if (text === this.deviceNameSynced) return
    this.deviceNameSynced = text
    void this.configScope.set('deviceName', text).catch(() => {})
  }

  /** secret 提交：空草稿不动既有配置；提交后立刻清空本地草稿。
   *  乐观置已配置标记（Host 纠偏回写前用户即可看到反馈），否则输入框清空
   *  又没有即时反馈，读起来像"值被吞了"。 */
  private commitSecret(field: 'token' | 'passphrase'): void {
    const text = field === 'token' ? this.tokenDraft : this.passphraseDraft
    if (text === '') return
    if (field === 'token') {
      this.tokenDraft = ''
      this.tokenCommitted = true
    } else {
      this.passphraseDraft = ''
      this.passphraseCommitted = true
    }
    this.reproject()
    void this.configScope.set(field, text).catch(() => {})
  }

  /** 布尔开关：点击即写（配置即时保存，无"确定"按钮）。 */
  private toggleBoolean(field: 'autoUpload' | 'checkOnStartup'): void {
    const current = this.configScope.getSnapshot().value?.[field] ?? true
    void this.configScope.set(field, !current).catch(() => {})
  }

  private reproject(): void {
    this.store.set(this.projection())
  }

  private projection(): CloudSyncCardState {
    const config = this.configScope.getSnapshot()
    const status = this.statusScope.getSnapshot().value
    // 令牌「可用」= Host 已配置，或本次新填了草稿（尚未写回也可发起测试）
    const tokenAvailable = status?.tokenConfigured === true || this.tokenDraft !== ''
    return {
      available: config.status !== 'unavailable',
      writable: config.writable,
      serverUrlDraft: this.serverUrlDraft,
      serverUrlInvalid: this.serverUrlDraft !== '' && !isValidServerUrl(this.serverUrlDraft),
      usernameDraft: this.usernameDraft,
      deviceNameDraft: this.deviceNameDraft,
      deviceNameInvalid: !isValidDeviceName(this.deviceNameDraft),
      tokenDraft: this.tokenDraft,
      passphraseDraft: this.passphraseDraft,
      tokenConfigured: status?.tokenConfigured === true || this.tokenCommitted,
      passphraseConfigured: status?.passphraseConfigured === true || this.passphraseCommitted,
      autoUpload: config.value?.autoUpload ?? true,
      checkOnStartup: config.value?.checkOnStartup ?? true,
      canTest: canRunServerAction(this.serverUrlDraft, tokenAvailable),
      canSync: canRunServerAction(this.serverUrlDraft, tokenAvailable),
      testPending: this.pendingTest !== null,
      syncPending: this.pendingSync !== null,
      statusLine: projectStatusLine({
        phase: status?.statusPhase ?? 'unconfigured',
        error: status?.statusError ?? '',
        errorDetail: status?.statusErrorDetail ?? '',
        cloudCount: status?.statusCloudCount ?? 0,
        lastSyncAt: status?.statusLastSyncAt ?? 0,
        now: this.now,
      }),
      syncResult: this.syncResult,
      restoreOpen: this.restoreOpen,
      catalog: this.catalog,
      catalogPending: this.pendingRestoreList !== null,
      restorePending: this.pendingRestore !== null,
      restoreOutcome: this.restoreOutcome,
      deviceFilter: this.deviceFilter,
      selectedKeys: [...this.selectedKeys],
      overrides: Object.fromEntries(this.overrides),
      mappings: parseMappings(status?.pathMappingsJson ?? '[]'),
      notice: this.projectNotice(status?.startupNoticeJson ?? ''),
      pickerAvailable: this.directoryPicker !== undefined,
    }
  }

  /** 启动通知投影：未读（at 晚于已读标记）才弹出。 */
  private projectNotice(raw: string): StartupNoticePayload | null {
    const notice = parseStartupNotice(raw)
    if (notice === null || notice.at <= this.noticeSeenAt) return null
    return notice
  }
}
