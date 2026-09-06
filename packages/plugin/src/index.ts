/**
 * dsh-cloud-sync Host 半入口：settings 注册、state 打开、kdf 引导、引擎生命周期。
 * 同步逻辑全部在 ./sync/engine.ts，这里只做与 cordis 的接线。
 */
import type { Context } from '@deepseek-ai/cordis'
import os from 'node:os'
import path from 'node:path'
import type { Domain, DomainSpec } from '@deepseek-ai/dsh-storage-domain'
import { Config, INITIAL_STATUS, StatusConfig, type Config as ConfigT, type StatusConfig as StatusConfigT } from './config.js'
import type { SettingsLike } from './dsh-types.js'
import { runConnectionCheck } from './status.js'
import { SyncEngine } from './sync/engine.js'
import { ProtocolError, SyncClient } from './sync/http-client.js'
import { bootstrapKdf } from './sync/kdf.js'
import {
  countRemoteOnlySessions,
  decodeMappingDelete,
  decodeRestoreRequest,
  deleteMapping,
  encodeCatalog,
  encodeMappings,
  encodeRestoreResult,
  encodeStartupNotice,
  fetchCatalog,
  markRestoredSynced,
  restoreSessions,
  type CatalogDeps,
  type RestoreDeps,
} from './sync/restore.js'
import { DomainStateStore, JsonFileStateStore, cloudSyncDomainSpec, type StateStore } from './sync/state.js'

export const name = 'cloud-sync'
export const inject = ['sessionPersistence']
export { Config, StatusConfig }

/**
 * 用户配置字段（引擎重启的最小集合）。通道字段已拆到 'cloud-sync-status'
 * namespace，这里仍保留 configKey 对比作双保险（belt-and-braces）。
 */
const USER_CONFIG_FIELDS = [
  'serverUrl',
  'token',
  'passphrase',
  'deviceName',
  'autoUpload',
  'checkOnStartup',
  'uploadDebounceMs',
  'pollIntervalMs',
  'requestTimeoutMs',
] as const

export function configKey(cfg: ConfigT): string {
  return JSON.stringify(USER_CONFIG_FIELDS.map((field) => cfg[field]))
}

interface StorageDomainLike {
  open<S extends DomainSpec>(spec: S): Promise<Domain<S>>
}

function dshHome(ctx: Context): string {
  const fromService = ctx.get('dshHomePath')?.()
  if (fromService) return fromService
  return process.env.DSH_HOME ?? path.join(os.homedir(), '.dsh')
}

export async function apply(ctx: Context, config: ConfigT): Promise<() => Promise<void>> {
  const logger = ctx.get('logger')?.('cloud-sync') ?? console

  let current: () => ConfigT = () => config
  /** 通道配置（'cloud-sync-status' namespace）的活视图；settings 缺失时恒为默认值 */
  let currentStatus: () => StatusConfigT = () => INITIAL_STATUS
  let engine: SyncEngine | undefined
  let pollTimer: NodeJS.Timeout | undefined
  /** session/flush 事件监听的 disposer（引擎停止时移除） */
  let flushHook: (() => void) | undefined
  let stateStore: StateStore | undefined
  let chain: Promise<void> = Promise.resolve()
  /** settings provider 引用（在 ctx.inject 块里捕获）；不存在时 writeStatus 为 no-op */
  let settingsProvider: SettingsLike | undefined
  /** 上次生效的用户配置 key（configKey 守卫） */
  let lastConfigKey = ''
  /** 已消费的触发器时间戳（消费 = 回写状态字段回显该值） */
  let consumedTestAt = 0
  let consumedSyncAllAt = 0
  let consumedRestoreListAt = 0
  let consumedRestoreAt = 0
  let consumedMappingDeleteAt = 0

  async function openState(): Promise<StateStore> {
    const storageDomain = ctx.get('storageDomain') as StorageDomainLike | undefined
    if (storageDomain) {
      try {
        return new DomainStateStore(await storageDomain.open(cloudSyncDomainSpec))
      } catch (error) {
        logger.warn(`storageDomain 不可用，降级 JSON 文件 state：${String(error)}`)
      }
    }
    return JsonFileStateStore.open(path.join(dshHome(ctx), 'cloud-sync'))
  }

  /**
   * kdf 引导（sync/kdf.ts）：读本机 sidecar，缺失时跨设备发现他机派生参数
   * （逐个试派生，meta 试解密验证），全部未命中才生成新 salt。
   */
  async function kdf(client: SyncClient, device: string): Promise<{ key: Buffer; salt: Buffer }> {
    return bootstrapKdf({
      client,
      device,
      passphrase: current().passphrase ?? '',
      onAdopt: (message) => logger.info(`kdf ${message}`),
    })
  }

  /** 状态字段回写（Host→Client 通道 'cloud-sync-status'）。dispose 后写会抛，吞掉即可。 */
  async function writeStatus(patch: Record<string, unknown>): Promise<void> {
    if (!settingsProvider) return
    try {
      await settingsProvider.update('cloud-sync-status', patch)
    } catch (error) {
      logger.warn(`状态回写失败：${String(error)}`)
    }
  }

  function configured(cfg: ConfigT): boolean {
    return Boolean(cfg.serverUrl && cfg.token && cfg.passphrase)
  }

  /** 连通性检查并回写状态；checkedAt 为已消费的 testRequestedAt（boot/配置变更的刷新不传）。 */
  async function checkAndReport(checkedAt?: number): Promise<void> {
    const cfg = current()
    if (!cfg.serverUrl || !cfg.token) {
      // 未配置：按钮本处于禁用态，防御性回写让客户端退出进行态
      await writeStatus({
        statusPhase: 'unconfigured',
        statusCloudCount: 0,
        statusError: '',
        statusErrorDetail: '',
        ...(checkedAt === undefined ? {} : { statusCheckedAt: checkedAt }),
      })
      return
    }
    const client = new SyncClient({
      serverUrl: cfg.serverUrl,
      username: cfg.username,
      token: cfg.token,
      timeoutMs: cfg.requestTimeoutMs,
    })
    const result = await runConnectionCheck({
      client,
      device: cfg.deviceName || os.hostname(),
      passphrase: cfg.passphrase ?? '',
    })
    await writeStatus({
      statusPhase: result.phase,
      statusCloudCount: result.cloudCount,
      statusError: result.error,
      statusErrorDetail: result.errorDetail,
      ...(checkedAt === undefined ? {} : { statusCheckedAt: checkedAt }),
    })
  }

  /** 「立即全部同步」触发器消费（docs/01 §5.3）。 */
  async function runSyncAll(at: number): Promise<void> {
    const eng = engine
    if (!eng) {
      // 引擎未运行（配置不齐全）：也回显消费值，让客户端退出进行态
      await writeStatus({ statusSyncAllAt: at, statusSyncAllOk: 0, statusSyncAllFailed: 0, statusSyncAllError: '' })
      return
    }
    const result = await eng.syncAllNow()
    await writeStatus({
      statusSyncAllAt: at,
      statusSyncAllOk: result.ok,
      statusSyncAllFailed: result.failed,
      statusSyncAllError: result.firstError ?? '',
    })
  }

  // ---- M4：恢复流程（docs/02 §4.3、01 §5.4/§5.5） ----

  function selfDevice(): string {
    return current().deviceName || os.hostname()
  }

  /** 本机工作区 canonical path 列表（workspaceRegistry 可选注入，缺失即无尾段建议）。 */
  function workspacePaths(): string[] {
    return ctx.get('workspaceRegistry')?.list().map((workspace) => workspace.path) ?? []
  }

  /** 构造恢复链路的 deps；配置不全返回 undefined（调用方回写 unconfigured 回显）。 */
  async function catalogDeps(): Promise<(CatalogDeps & RestoreDeps) | undefined> {
    const cfg = current()
    if (!cfg.serverUrl || !cfg.token || !cfg.passphrase || !stateStore) return undefined
    const client = new SyncClient({ serverUrl: cfg.serverUrl, username: cfg.username, token: cfg.token, timeoutMs: cfg.requestTimeoutMs })
    const { key } = await kdf(client, selfDevice())
    return {
      client,
      key,
      persistence: ctx.sessionPersistence,
      state: stateStore,
      workspacePaths: workspacePaths(),
      // 恢复落位后的 workspace 挂载（web 侧边栏可见性）。复刻 dsh 自己创建会话的
      // 路径（session-controller commands.ts）：resolveByPath 复用已有工作区，
      // 无则 create（registry 自带 realpath + isDirectory 校验），再 attachSession。
      // restore 侧已预校验目标目录存在；这里失败时 restoreOne 只告警不回滚
      attachWorkspace: (sessionId, cwd) => {
        const registry = ctx.get('workspaceRegistry')
        if (!registry) return Promise.resolve()
        return (async () => {
          const workspace = await registry.resolveByPath(cwd) ?? await registry.create(cwd)
          await workspace.attachSession(sessionId)
        })()
      },
      onWarn: (message) => logger.warn(message),
    }
  }

  /** 「从云端恢复会话…」目录拉取触发器消费。 */
  async function runRestoreList(at: number): Promise<void> {
    const deps = await catalogDeps().catch((error: unknown) => {
      logger.warn(`恢复目录引导失败：${String(error)}`)
      return undefined
    })
    if (!deps) {
      await writeStatus({ restoreCatalogJson: encodeCatalog({ at, selfDevice: selfDevice(), sessions: [], error: 'unconfigured' }) })
      return
    }
    try {
      const sessions = await fetchCatalog(deps)
      await writeStatus({ restoreCatalogJson: encodeCatalog({ at, selfDevice: selfDevice(), sessions, error: '' }) })
    } catch (error) {
      const code = error instanceof ProtocolError && error.status === 401
        ? 'tokenInvalid'
        : error instanceof ProtocolError && error.status === 403 ? 'userMismatch' : 'unreachable'
      await writeStatus({ restoreCatalogJson: encodeCatalog({ at, selfDevice: selfDevice(), sessions: [], error: code }) })
    }
  }

  /** 「恢复选中会话」请求消费：逐条落位后抑制立刻回传，并回写映射列表与结果。 */
  async function runRestore(request: { at: number; items: { sessionId: string; device: string; targetCwd: string | null }[] }): Promise<void> {
    const deps = await catalogDeps().catch((error: unknown) => {
      logger.warn(`恢复引导失败：${String(error)}`)
      return undefined
    })
    if (!deps) {
      await writeStatus({ restoreResultJson: encodeRestoreResult({ at: request.at, ok: 0, failed: request.items.length, firstError: 'unconfigured' }) })
      return
    }
    try {
      const result = await restoreSessions(deps, request.items)
      // 抑制立刻回传：以落位后的当前 revision 记 state（§4.5，见 markRestoredSynced 注释）
      if (result.ok > 0) {
        const restoredIds = request.items.map((item) => item.sessionId)
        await markRestoredSynced(deps, restoredIds).catch((error: unknown) => {
          logger.warn(`恢复后 state 标记失败（将导致全量回传一次，不丢数据）：${String(error)}`)
        })
      }
      await writeStatus({
        restoreResultJson: encodeRestoreResult({ ...result, at: request.at }),
        pathMappingsJson: encodeMappings(deps.state.getGlobal().pathMappings),
      })
    } catch (error) {
      await writeStatus({
        restoreResultJson: encodeRestoreResult({ at: request.at, ok: 0, failed: request.items.length, firstError: String(error).slice(0, 300) }),
      })
    }
  }

  /** 「路径映射」区的删除请求消费。 */
  async function runMappingDelete(from: string): Promise<void> {
    if (!stateStore) return
    const mappings = await deleteMapping(stateStore, from)
    await writeStatus({ pathMappingsJson: encodeMappings(mappings) })
  }

  /** 启动检查（01 §5.5）：配置有效且开关开启时，拉目录数出他机增量并写通知。 */
  async function runStartupCheck(): Promise<void> {
    if (!current().checkOnStartup) return
    const deps = await catalogDeps().catch(() => undefined)
    if (!deps) return
    try {
      const count = await countRemoteOnlySessions(deps, selfDevice())
      if (count > 0) {
        await writeStatus({ startupNoticeJson: encodeStartupNotice({ at: Date.now(), count }) })
      }
    } catch (error) {
      logger.warn(`启动检查失败（忽略）：${String(error)}`)
    }
  }

  async function startEngine(): Promise<void> {
    const cfg = current()
    if (!cfg.serverUrl || !cfg.token || !cfg.passphrase) {
      logger.info('serverUrl/token/passphrase 未配置齐全，云同步未启动')
      return
    }
    const client = new SyncClient({
      serverUrl: cfg.serverUrl,
      username: cfg.username,
      token: cfg.token,
      timeoutMs: cfg.requestTimeoutMs,
    })
    const device = cfg.deviceName || os.hostname()
    const { key, salt } = await kdf(client, device)
    stateStore ??= await openState()
    const eng = new SyncEngine({
      client,
      key,
      salt,
      device,
      state: stateStore,
      persistence: ctx.sessionPersistence,
      getConfig: () => current(),
      onEvent: (event) => {
        if (event.kind === 'error' || event.kind === 'conflict') {
          logger.warn(`[${event.kind}] ${event.sessionId}: ${event.message ?? ''}`)
        } else {
          logger.debug?.(`[${event.kind}] ${event.sessionId} ${event.bytes ?? ''}`)
        }
        // 引擎事件 → 状态字段回写（docs/01 §5.2/§6）
        if (event.kind === 'uploaded') {
          void writeStatus({ statusLastSyncAt: Date.now(), statusError: '', statusErrorDetail: '' })
        } else if (event.kind === 'error') {
          void writeStatus({ statusError: 'syncFailed', statusErrorDetail: (event.message ?? '').slice(0, 300) })
        } else if (event.kind === 'conflict') {
          // 状态行提示换设备名并附触发会话 id
          void writeStatus({ statusError: 'deviceConflict', statusErrorDetail: event.sessionId })
        }
      },
    })
    engine = eng
    pollTimer = setInterval(() => void eng.scan(), current().pollIntervalMs)
    pollTimer.unref?.()
    // session/flush 接线（M5，替代纯轮询的首选变更源）：dsh 把缓冲事件落盘的
    // durability checkpoint 是磁盘字节真正变化的时刻，合并窗口后触发一轮
    // 变更发现；轮询兜底保留（恢复落位等不经 live 会话的变更）。
    // listener 只拨 timer，重活留给 scan/防抖队列（flush 是 awaited checkpoint）
    flushHook = ctx.on('session/flush', () => {
      eng.requestScan()
    })
    await eng.start()
  }

  async function stopEngine(): Promise<void> {
    if (pollTimer) {
      clearInterval(pollTimer)
      pollTimer = undefined
    }
    flushHook?.()
    flushHook = undefined
    const eng = engine
    engine = undefined
    await eng?.dispose()
  }

  /** 配置变更：串行重启引擎（installSection 初次也会触发一次 onChange）。
   *  启动失败（如服务器不可达时 kdf 引导被拒）必须就地收容：写 failed 状态 + 日志，
   *  绝不能让拒绝逃逸出 chain —— 否则 cordis 会按 fatal load failure 杀掉整个 dsh 进程。 */
  function restart(): Promise<void> {
    chain = chain.then(async () => {
      try {
        await stopEngine()
      } catch (error) {
        logger.warn(`引擎停止异常（忽略，继续重启）：${String(error)}`)
      }
      try {
        await startEngine()
      } catch (error) {
        logger.warn(`引擎启动失败：${String(error)}`)
        await writeStatus({
          statusPhase: 'failed',
          statusError: 'unreachable',
          statusErrorDetail: String(error).slice(0, 300),
        })
      }
    })
    return chain
  }

  /** configKey 守卫：只有 9 个用户配置字段变了才重启；状态回写不会触发。 */
  function restartIfConfigChanged(): Promise<void> | undefined {
    const key = configKey(current())
    if (key === lastConfigKey) return undefined
    lastConfigKey = key
    return restart()
  }

  /**
   * 'cloud-sync'（用户配置）onChange：纠偏 secret 信号（写到 status namespace）→
   * 按需重启引擎。Host 永不写这个 namespace，用户配置写零冲突。
   */
  function onConfigChange(): void {
    const cfg = current()
    const status = currentStatus()

    // tokenConfigured/passphraseConfigured 与实际 secret 非空对齐（收敛一轮即停）
    const fixes: Record<string, unknown> = {}
    if (status.tokenConfigured !== Boolean(cfg.token)) fixes.tokenConfigured = Boolean(cfg.token)
    if (status.passphraseConfigured !== Boolean(cfg.passphrase)) fixes.passphraseConfigured = Boolean(cfg.passphrase)
    if (Object.keys(fixes).length > 0) void writeStatus(fixes)

    const restarted = restartIfConfigChanged()
    if (restarted) {
      // 配置变了：重启后补一次连通性检查刷新状态
      void restarted.then(async () => {
        if (configured(current())) await checkAndReport()
      }).catch((error: unknown) => {
        logger.warn(`配置变更后的连通性检查异常：${String(error)}`)
      })
    }
  }

  /**
   * 'cloud-sync-status'（通道）onChange：只消费触发器。
   * Host 自己的状态回写也会触发这里——「大于已消费值才消费」的守卫保证幂等，无循环。
   */
  function onStatusChange(): void {
    const status = currentStatus()

    // 触发器消费：只认比已消费值更新的时间戳；回写状态字段再次触发 onChange 时不会重复消费
    if (status.testRequestedAt > consumedTestAt) {
      consumedTestAt = status.testRequestedAt
      void checkAndReport(consumedTestAt).catch((error: unknown) => {
        logger.warn(`连通性检查异常：${String(error)}`)
      })
    }
    if (status.syncAllRequestedAt > consumedSyncAllAt) {
      consumedSyncAllAt = status.syncAllRequestedAt
      void runSyncAll(consumedSyncAllAt).catch((error: unknown) => {
        logger.warn(`立即全部同步异常：${String(error)}`)
      })
    }
    if (status.restoreListRequestedAt > consumedRestoreListAt) {
      consumedRestoreListAt = status.restoreListRequestedAt
      void runRestoreList(consumedRestoreListAt).catch((error: unknown) => {
        logger.warn(`恢复目录拉取异常：${String(error)}`)
      })
    }
    const restoreRequest = decodeRestoreRequest(status.restoreRequestJson)
    if (restoreRequest !== undefined && restoreRequest.at > consumedRestoreAt) {
      consumedRestoreAt = restoreRequest.at
      void runRestore(restoreRequest).catch((error: unknown) => {
        logger.warn(`恢复执行异常：${String(error)}`)
      })
    }
    const mappingDelete = decodeMappingDelete(status.mappingDeleteJson)
    if (mappingDelete !== undefined && mappingDelete.at > consumedMappingDeleteAt) {
      consumedMappingDeleteAt = mappingDelete.at
      void runMappingDelete(mappingDelete.from).catch((error: unknown) => {
        logger.warn(`映射删除异常：${String(error)}`)
      })
    }
  }

  stateStore = await openState()

  // settings 是可选服务：有则注册两个 namespace（用户配置 + Host↔Client 通道），
  // 配置改动即时生效；无则只用 cordis 层 Config（patch 静态配置）
  ctx.inject(['settings'], (settingsCtx) => {
    settingsProvider = settingsCtx.settings
    // 先注册通道 namespace 再注册用户配置：installSection 会同步触发 onChange，
    // onConfigChange 里的 tokenConfigured/passphraseConfigured 对齐回写目标是
    // 'cloud-sync-status'——若它还没注册，回写抛错丢失，徽标会一直停在「未配置」
    settingsCtx.settings?.installSection(ctx, 'cloud-sync-status', StatusConfig, INITIAL_STATUS, {
      setSource: (source) => {
        currentStatus = source
      },
      onChange: onStatusChange,
    })
    settingsCtx.settings?.installSection(ctx, 'cloud-sync', Config, config, {
      setSource: (source) => {
        current = source
      },
      onChange: onConfigChange,
    })
  })

  // 初次启动也走串行 chain：settings 的 onChange 在 installSection 时已触发一次
  // restart（configKey 已记录，这里不重复）；settings 缺失时这里补上初次启动
  await restartIfConfigChanged()

  // Boot 状态刷新：配置齐全则跑一次连通性检查；未配置则把状态字段重置为 unconfigured
  // 启动检查（checkOnStartup 的云端增量检查）在连通性确认后进行
  const bootCfg = current()
  try {
    // 已学习映射列表随 boot 下发（设置卡「路径映射」区的数据源）
    if (stateStore) {
      const global = stateStore.getGlobal()
      await writeStatus({ pathMappingsJson: encodeMappings(global.pathMappings) })
      // lastSyncAt 持久化回读（M5）：重启后「最近同步」时间不丢
      if (global.lastSyncAt) await writeStatus({ statusLastSyncAt: global.lastSyncAt })
    }
    if (configured(bootCfg)) {
      await checkAndReport()
      // 错误摘要持久化（M5）：引擎 lastError 存在 state（跨重启）。连通性正常时
      // 回显上次的同步错误（连接错误优先显示）；上传成功时引擎会清 lastError
      // 并回写空 statusError，残留窗口到下一轮重试为止
      const global = stateStore?.getGlobal()
      if (global?.lastError && currentStatus().statusError === '') {
        await writeStatus({ statusError: 'syncFailed', statusErrorDetail: global.lastError.slice(0, 300) })
      }
      await runStartupCheck()
      await checkAndReport()
      await runStartupCheck()
    } else if (currentStatus().statusPhase !== 'unconfigured') {
      await writeStatus({ statusPhase: 'unconfigured', statusCloudCount: 0, statusError: '', statusErrorDetail: '' })
    }
  } catch (error) {
    logger.warn(`boot 状态刷新异常（忽略）：${String(error)}`)
  }

  return async () => {
    chain = chain.then(async () => {
      await stopEngine() // dispose 内会强制冲刷在途批次
      await stateStore?.close()
    })
    await chain
  }
}
