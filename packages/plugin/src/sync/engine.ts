/**
 * 上行同步引擎（docs/02 §4.2、§10）。
 *
 * 职责：变更发现（listSnapshots revision 对比 + 定时兜底）→ 按字节偏移读新增
 * → zstd 帧边界扫描取完整帧 → 链式 GCM 分段加密 → append 上传（409 幂等判定）
 * → meta 覆写 → 推进本地 state。与 cordis 解耦，纯类便于单测。
 */
import fsp from 'node:fs/promises'
import path from 'node:path'
import { LogEncryptor, encryptMeta, verifyTailSegment, type SessionMeta } from '../crypto/envelope.js'
import type { SessionHeaderLike, SessionPersistenceLike, SessionSnapshotLike } from '../dsh-types.js'
import { detectEncoding, emptyFold, foldFrame, scanZstdFrames } from './frames.js'
import { ProtocolError, type SyncClient } from './http-client.js'
import type { SessionSyncState, StateStore } from './state.js'

const BACKOFF_INITIAL_MS = 1000
const BACKOFF_MAX_MS = 5 * 60 * 1000
/** flush 钩子触发 scan 的合并窗口：一轮对话多次 flush 只做一次变更发现。 */
const SCAN_DEBOUNCE_MS = 500

export interface SyncEngineOptions {
  client: SyncClient
  /** scrypt 派生后的密钥与 salt（kdf.json 引导完成后再构造引擎） */
  key: Buffer
  salt: Buffer
  device: string
  state: StateStore
  persistence: SessionPersistenceLike
  /** 活配置（设置卡改动即时生效） */
  getConfig(): { autoUpload: boolean; uploadDebounceMs: number }
  /** 状态行/日志出口 */
  onEvent?: (event: SyncEvent) => void
  now?: () => number
}

export interface SyncEvent {
  kind: 'uploaded' | 'skipped-plain' | 'conflict' | 'error'
  sessionId: string
  message?: string
  bytes?: number
}

/** syncAllNow 的结果摘要（docs/01 §5.3：成功 N · 失败 M，附首个错误）。 */
export interface SyncAllResult {
  ok: number
  failed: number
  firstError?: string
}

interface ScheduledSync {
  snapshot: SessionSnapshotLike
  timer: NodeJS.Timeout
}

interface Backoff {
  delayMs: number
  nextRetryAt: number
  /** 进入退避时的快照 revision：新一轮 scan 发现 revision 变化即重置退避（02 §10） */
  revision: string
}

/** 409 幂等校验不通过：写入方冲突（疑似同名设备的另一台机器）。 */
export class ConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConflictError'
  }
}

export function logKey(device: string, sessionId: string): string {
  return `sessions/${device}/${sessionId}.log.enc`
}

export function metaKey(device: string, sessionId: string): string {
  return `sessions/${device}/${sessionId}.meta.enc`
}

export function freshSessionState(): SessionSyncState {
  return {
    uploadedBytes: 0,
    remoteBytes: 0,
    lastSegmentIndex: -1,
    lastTag: '',
    localRevision: '',
    eventCount: 0,
    updatedAt: 0,
  }
}

export class SyncEngine {
  private scheduled = new Map<string, ScheduledSync>()
  private latest = new Map<string, SessionSnapshotLike>()
  private inFlight = new Set<string>()
  private rerunRequested = new Set<string>()
  private backoff = new Map<string, Backoff>()
  private scanTimer: NodeJS.Timeout | undefined
  private disposed = false
  private now: () => number

  constructor(private options: SyncEngineOptions) {
    this.now = options.now ?? Date.now
  }

  /**
   * 外部触发的变更发现入口（session/flush 钩子接线，M5）：把窗口内的多次
   * 触发合并为一次 scan。listener 必须轻——flush 是 awaited durability
   * checkpoint，重活留给 scan/防抖队列，这里只拨一个 timer。
   */
  requestScan(): void {
    if (this.disposed || !this.options.getConfig().autoUpload) return
    if (this.scanTimer !== undefined) return
    this.scanTimer = setTimeout(() => {
      this.scanTimer = undefined
      void this.scan()
    }, SCAN_DEBOUNCE_MS)
    this.scanTimer.unref?.()
  }

  /** 一轮变更发现：revision 对比，变化的进防抖队列。 */
  async scan(): Promise<void> {
    if (this.disposed || !this.options.getConfig().autoUpload) return
    let snapshots: SessionSnapshotLike[]
    try {
      snapshots = await this.options.persistence.listSnapshots()
    } catch (error) {
      this.emit({ kind: 'error', sessionId: '', message: `listSnapshots failed: ${String(error)}` })
      return
    }
    for (const snapshot of snapshots) {
      if (!this.needsSync(snapshot)) continue
      this.schedule(snapshot)
    }
  }

  /** 变更判定：revision 与 state 不一致（或处于退避待重试）才需要同步。 */
  private needsSync(snapshot: SessionSnapshotLike): boolean {
    const state = this.options.state.getSession(snapshot.header.id)
    if (state?.status === 'conflict' || state?.status === 'skipped-plain') return false
    const wait = this.backoff.get(snapshot.header.id)
    if (wait !== undefined && wait.revision !== snapshot.revision) {
      // 会话有新变更：重置退避立即重试（docs/02 §10「下一次会话变更重置退避」）
      this.backoff.delete(snapshot.header.id)
      return true
    }
    // 自愈：从未上传过任何字节、又不是恢复抑制（restoredAt）的条目，其
    // localRevision 记录不可信——历史上被「ENOENT 静默跳过」污染过的会话
    // 曾因此永远卡在「已同步」假象里。一律视为待同步，宁可重试不可漏传。
    if (state !== undefined && state.uploadedBytes === 0 && !state.restoredAt) return true
    if (state?.localRevision === snapshot.revision && wait === undefined) return false
    return true
  }

  /**
   * 立即全部同步（设置卡「立即全部同步」按钮，docs/01 §5.3）：
   * 用户显式触发，无视 autoUpload 开关；全量扫描后把所有待同步会话
   * 调度进队列并 await 完成（复用 schedule/flush 防抖-冲刷机制）。
   */
  async syncAllNow(): Promise<SyncAllResult> {
    if (this.disposed) return { ok: 0, failed: 0 }
    // 用户显式触发：重置全部退避（手动同步的语义至少等同一次会话变更）
    this.backoff.clear()
    let snapshots: SessionSnapshotLike[]
    try {
      snapshots = await this.options.persistence.listSnapshots()
    } catch (error) {
      return { ok: 0, failed: 1, firstError: `listSnapshots failed: ${String(error)}`.slice(0, 300) }
    }
    const targets = snapshots.filter((snapshot) => this.needsSync(snapshot))
    for (const snapshot of targets) this.schedule(snapshot)
    await this.flush()
    let ok = 0
    let failed = 0
    let firstError: string | undefined
    for (const snapshot of targets) {
      const state = this.options.state.getSession(snapshot.header.id)
      if (state?.status === 'error' || state?.status === 'conflict') {
        failed += 1
        firstError ??= `${snapshot.header.id}: ${state.error ?? ''}`.slice(0, 300)
      } else {
        ok += 1
      }
    }
    return { ok, failed, firstError }
  }

  /** 同会话变更在防抖窗口内合并为一次上传。 */
  private schedule(snapshot: SessionSnapshotLike): void {
    if (this.disposed) return
    const id = snapshot.header.id
    this.latest.set(id, snapshot)
    const existing = this.scheduled.get(id)
    if (existing) clearTimeout(existing.timer)
    const timer = setTimeout(() => {
      this.scheduled.delete(id)
      void this.pump(id)
    }, this.options.getConfig().uploadDebounceMs)
    timer.unref?.()
    this.scheduled.set(id, { snapshot, timer })
  }

  /** 进程退出前冲刷：立即执行所有防抖中的会话并等待在途上传结束。 */
  async flush(): Promise<void> {
    const ids = [...this.scheduled.keys()]
    for (const { timer } of this.scheduled.values()) clearTimeout(timer)
    this.scheduled.clear()
    await Promise.all(ids.map((id) => this.pump(id)))
  }

  async dispose(): Promise<void> {
    if (this.scanTimer !== undefined) {
      clearTimeout(this.scanTimer)
      this.scanTimer = undefined
    }
    await this.flush() // 退出前强制冲刷在途批次
    this.disposed = true
    // 等在途上传收尾（dispose 不发起新同步）
    while (this.inFlight.size > 0) {
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
  }

  /** 启动：解除 conflict 状态（配置如设备名可能已更换，允许重试），然后做一轮变更发现。 */
  async start(): Promise<void> {
    for (const [id, state] of this.options.state.entries()) {
      if (state.status === 'conflict' || state.status === 'error') {
        await this.options.state.putSession(id, { ...state, status: 'ok', error: undefined })
      }
    }
    await this.scan()
  }

  /** 每会话串行泵：在途期间到来的变更置 rerun 标记，结束后立即再跑一轮。 */
  private async pump(sessionId: string): Promise<void> {
    if (this.disposed) return
    if (this.inFlight.has(sessionId)) {
      this.rerunRequested.add(sessionId)
      return
    }
    this.inFlight.add(sessionId)
    try {
      do {
        this.rerunRequested.delete(sessionId)
        const snapshot = this.latest.get(sessionId)
        if (!snapshot) break
        await this.syncSession(snapshot)
      } while (this.rerunRequested.has(sessionId) && !this.disposed)
    } finally {
      this.inFlight.delete(sessionId)
    }
  }

  private emit(event: SyncEvent): void {
    this.options.onEvent?.(event)
  }

  private async syncSession(snapshot: SessionSnapshotLike): Promise<void> {
    const id = snapshot.header.id
    const state = this.options.state.getSession(id) ?? freshSessionState()
    try {
      await this.syncSessionOnce(snapshot, state)
      this.backoff.delete(id)
    } catch (error) {
      if (error instanceof ConflictError) {
        state.status = 'conflict'
        state.error = error.message
        await this.options.state.putSession(id, state)
        this.emit({ kind: 'conflict', sessionId: id, message: error.message })
        return
      }
      const prev = this.backoff.get(id)
      const delayMs = Math.min(prev ? prev.delayMs * 2 : BACKOFF_INITIAL_MS, BACKOFF_MAX_MS)
      this.backoff.set(id, { delayMs, nextRetryAt: this.now() + delayMs, revision: snapshot.revision })
      state.status = 'error'
      state.error = String(error)
      await this.options.state.putSession(id, state)
      await this.options.state.setGlobal({ lastError: String(error) })
      this.emit({ kind: 'error', sessionId: id, message: String(error) })
      // 退避到点后由下一轮 scan 兜底重试（revision 与 state 不一致会再次 schedule）
    }
  }

  private async syncSessionOnce(snapshot: SessionSnapshotLike, state: SessionSyncState): Promise<void> {
    const { header, revision } = snapshot
    const id = header.id
    const { client, state: store } = this.options

    const wait = this.backoff.get(id)
    if (wait && this.now() < wait.nextRetryAt) return

    const location = this.options.persistence.locate(header)
    if (!location) {
      // 无单文件 artifact 的后端（如 SQLite）：不同步，标记后不再扫描
      state.status = 'skipped-plain'
      state.error = 'persistence backend exposes no file artifact'
      state.localRevision = revision
      await store.putSession(id, state)
      return
    }

    let stat: { size: number }
    try {
      stat = await fsp.stat(location.path)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      // 区分两种 ENOENT：目录里有 canonical 日志（session[.vN].jsonl[.zstd]）而
      // locate 指的路径不存在 = 布局推导失配（上游改名/改布局），静默跳过会把
      // 失配伪装成「已同步」（曾表现为「成功 0」无任何报错），必须抛错暴露；
      // 目录不存在或只有 session.lock（v1 后端 lock 先建目录、首个 append 才
      // 物化日志）= 真未物化，记 revision 静默跳过，物化后 revision 变化自然重调度。
      const dirEntries = await fsp.readdir(path.dirname(location.path)).catch(
        (dirError: NodeJS.ErrnoException) => {
          if (dirError.code === 'ENOENT') return [] as string[]
          throw dirError
        },
      )
      const hasCanonicalLog = dirEntries.some((name) => /^session(\.v\d+)?\.jsonl(\.zstd)?$/.test(name))
      if (hasCanonicalLog) {
        throw new Error(`session log artifact not found at derived path (layout mismatch?): ${location.path}`)
      }
      state.localRevision = revision
      await store.putSession(id, state)
      return
    }
    if (stat.size < state.uploadedBytes) {
      // 文件变短（防御：正常不可达）——回退全量重传
      Object.assign(state, freshSessionState())
    }

    // 明文 profile 检测（仅首传判断，之后由 state 记住）
    if (state.uploadedBytes === 0 && state.lastSegmentIndex === -1) {
      const handle = await fsp.open(location.path, 'r')
      try {
        const prefix = Buffer.alloc(4)
        await handle.read(prefix, 0, 4, 0)
        if (detectEncoding(prefix) !== 'zstd') {
          state.status = 'skipped-plain'
          state.error = 'session artifact is not zstd-compressed (compression: none profile)'
          state.localRevision = revision
          await store.putSession(id, state)
          this.emit({ kind: 'skipped-plain', sessionId: id })
          return
        }
      } finally {
        await handle.close()
      }
    }

    const newBytes = await readTail(location.path, state.uploadedBytes)
    if (newBytes.length === 0) {
      state.localRevision = revision
      await store.putSession(id, state)
      return
    }

    const scan = scanZstdFrames(newBytes)
    if (scan.frames.length === 0) {
      // 没有完整帧（写入进行中），等下一窗口
      state.localRevision = revision
      await store.putSession(id, state)
      return
    }
    const last = scan.frames[scan.frames.length - 1]
    const plaintext = newBytes.subarray(0, last.end)

    // 链式分段加密（从 state 恢复段序号与前段 tag）
    const nextIndex = state.lastSegmentIndex + 1
    const encryptor = new LogEncryptor(
      this.options.key,
      this.options.salt,
      id,
      nextIndex,
      state.lastTag ? Buffer.from(state.lastTag, 'hex') : undefined,
    )
    const segment = encryptor.append(plaintext)
    const payload = state.remoteBytes === 0 ? Buffer.concat([encryptor.objectHeader(), segment]) : segment

    const key = logKey(this.options.device, id)
    try {
      if (state.remoteBytes === 0) {
        await client.overwrite(key, payload)
      } else {
        await client.append(key, state.remoteBytes, payload)
      }
    } catch (error) {
      if (!(error instanceof ProtocolError) || error.status !== 409) throw error
      // 409 幂等判定：通过则不重传、直接随下方流程推进 state
      await this.resolve409(key, id, nextIndex, state, segment, plaintext, error.currentLength)
    }

    // meta 折叠：解压本段全部帧
    const fold = emptyFold()
    for (const frame of scan.frames) {
      await foldFrame(newBytes.subarray(frame.start, frame.end), fold)
    }

    state.uploadedBytes += plaintext.length
    state.remoteBytes += payload.length
    state.lastSegmentIndex = nextIndex
    state.lastTag = encryptor.lastTag.toString('hex')
    state.localRevision = revision
    state.eventCount += fold.eventCount
    if (fold.title !== undefined) state.title = fold.title
    state.updatedAt = Math.max(state.updatedAt, fold.updatedAt)
    state.status = 'ok'
    state.error = undefined

    const meta: SessionMeta = {
      sessionId: id,
      title: state.title ?? '',
      createdAt: header.createdAt,
      updatedAt: state.updatedAt || header.createdAt,
      eventCount: state.eventCount,
      formatVersion: header.version,
      cwd: header.cwd ?? '',
      device: this.options.device,
    }
    await client.overwrite(metaKey(this.options.device, id), encryptMeta(this.options.key, this.options.salt, id, meta))

    await store.putSession(id, state)
    await store.setGlobal({ lastSyncAt: this.now(), lastError: undefined })
    this.emit({ kind: 'uploaded', sessionId: id, bytes: payload.length })
  }

  /**
   * 409 幂等判定（docs/02 §10）：服务端长度恰等于「state 偏移 + 待传段长」时，
   * 下载末段做链式 AAD 校验并比对明文——通过则视为上次上传已成功（不重复上传）；
   * 否则判定写入方冲突，抛 ConflictError 停止该会话同步，不做盲目全量覆写。
   */
  private async resolve409(
    key: string,
    sessionId: string,
    segmentIndex: number,
    state: SessionSyncState,
    segment: Buffer,
    plaintext: Buffer,
    serverLength: number | undefined,
  ): Promise<void> {
    const expected = state.remoteBytes + segment.length
    if (serverLength === undefined || serverLength !== expected) {
      throw new ConflictError(
        `409 on ${key}: server length ${serverLength ?? '?'} != state ${state.remoteBytes} + segment ${segment.length}`,
      )
    }
    const tail = await this.options.client.downloadRange(key, serverLength - segment.length, serverLength - 1)
    const prevTag = state.lastTag ? Buffer.from(state.lastTag, 'hex') : null
    let decoded: Buffer
    try {
      decoded = verifyTailSegment(this.options.key, sessionId, segmentIndex, prevTag, tail)
    } catch {
      throw new ConflictError(`409 on ${key}: tail segment failed chained-AAD verification`)
    }
    if (!decoded.equals(plaintext)) {
      throw new ConflictError(`409 on ${key}: tail segment plaintext differs from local`)
    }
    // 幂等确认：上次上传其实成功了，只是 state 未推进
  }
}

async function readTail(file: string, offset: number): Promise<Buffer> {
  const handle = await fsp.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (stat.size <= offset) return Buffer.alloc(0)
    const buffer = Buffer.alloc(stat.size - offset)
    await handle.read(buffer, 0, buffer.length, offset)
    return buffer
  } finally {
    await handle.close()
  }
}
