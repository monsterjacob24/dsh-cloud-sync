/**
 * 本地同步状态（docs/02 §7）：首选 dsh storageDomain 版本化 KV 域，
 * 不可用时降级为 $DSH_HOME 下插件自建子目录的单文件 JSON。
 */
import { defineDomain, domainTable, type Domain } from '@deepseek-ai/dsh-storage-domain'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'

/** 每会话同步进度。uploadedBytes 是明文读取偏移，remoteBytes 是云端密文长度。 */
export interface SessionSyncState {
  uploadedBytes: number
  remoteBytes: number
  /** 已上传的最后段序号，-1 表示尚未上传任何段 */
  lastSegmentIndex: number
  /** 最后段的 GCM tag（hex），空串表示尚未上传任何段 */
  lastTag: string
  /** 上次处理到的 sessionPersistence revision（不透明令牌） */
  localRevision: string
  /** 恢复抑制标记（markRestoredSynced 写入）：本地续写前不回传 */
  restoredAt?: number
  /** meta 折叠累积 */
  eventCount: number
  title?: string
  updatedAt: number
  status?: 'ok' | 'skipped-plain' | 'conflict' | 'error'
  error?: string
}

/** 全局状态；pathMappings 预留给 M4 的路径归位学习。 */
export interface GlobalState {
  lastSyncAt?: number
  lastError?: string
  pathMappings: { from: string; to: string }[]
}

export interface StateStore {
  getSession(id: string): SessionSyncState | undefined
  putSession(id: string, state: SessionSyncState): Promise<void>
  entries(): IterableIterator<[string, SessionSyncState]>
  getGlobal(): GlobalState
  setGlobal(patch: Partial<GlobalState>): Promise<void>
  close(): Promise<void>
}

const sessionStateSchema = z.object({
  uploadedBytes: z.number().int().nonnegative(),
  remoteBytes: z.number().int().nonnegative(),
  lastSegmentIndex: z.number().int().min(-1),
  lastTag: z.string(),
  localRevision: z.string(),
  restoredAt: z.number().optional(),
  eventCount: z.number().int().nonnegative(),
  title: z.string().optional(),
  updatedAt: z.number(),
  status: z.enum(['ok', 'skipped-plain', 'conflict', 'error']).optional(),
  error: z.string().optional(),
})

const globalStateSchema = z.object({
  lastSyncAt: z.number().optional(),
  lastError: z.string().optional(),
  pathMappings: z.array(z.object({ from: z.string(), to: z.string() })),
})

export const INITIAL_GLOBAL: GlobalState = { pathMappings: [] }

/** storageDomain 实现（首选）。 */
export const cloudSyncDomainSpec = defineDomain({
  name: 'cloud_sync', // UNIT_NAME_RE 只允许小写字母数字下划线（与 settings 的 cloud-sync 不同体系）
  version: 1,
  global: { schema: globalStateSchema, initial: INITIAL_GLOBAL },
  tables: {
    sessions: domainTable<string, SessionSyncState>(sessionStateSchema),
  },
})

type CloudSyncDomain = Domain<typeof cloudSyncDomainSpec>

export class DomainStateStore implements StateStore {
  constructor(private domain: CloudSyncDomain) {}

  getSession(id: string): SessionSyncState | undefined {
    return this.domain.table('sessions').get(id)
  }

  entries(): IterableIterator<[string, SessionSyncState]> {
    return this.domain.table('sessions').entries()
  }

  async putSession(id: string, state: SessionSyncState): Promise<void> {
    await this.domain.table('sessions').put(id, state)
  }

  getGlobal(): GlobalState {
    return this.domain.global.get()
  }

  async setGlobal(patch: Partial<GlobalState>): Promise<void> {
    await this.domain.global.set({ ...this.domain.global.get(), ...patch })
  }

  async close(): Promise<void> {
    await this.domain.close()
  }
}

/** JSON 单文件降级实现：tmp + rename 原子写。 */
export class JsonFileStateStore implements StateStore {
  private file: string
  private sessions = new Map<string, SessionSyncState>()
  private global: GlobalState = INITIAL_GLOBAL
  private writing: Promise<void> = Promise.resolve()

  private constructor(dir: string) {
    this.file = path.join(dir, 'state.json')
  }

  /** 打开（或创建）state 文件；损坏时回退为空 state（即全量重传），不阻断启动。 */
  static async open(dir: string): Promise<JsonFileStateStore> {
    const store = new JsonFileStateStore(dir)
    try {
      const parsed = JSON.parse(await fsp.readFile(store.file, 'utf8')) as {
        sessions?: Record<string, SessionSyncState>
        global?: GlobalState
      }
      for (const [id, state] of Object.entries(parsed.sessions ?? {})) store.sessions.set(id, state)
      if (parsed.global) store.global = { ...INITIAL_GLOBAL, ...parsed.global }
    } catch {
      // 缺失或损坏即空 state
    }
    return store
  }

  private persist(): Promise<void> {
    const snapshot = JSON.stringify({
      sessions: Object.fromEntries(this.sessions),
      global: this.global,
    })
    this.writing = this.writing.then(async () => {
      await fsp.mkdir(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.tmp-${process.pid}`
      await fsp.writeFile(tmp, snapshot)
      await fsp.rename(tmp, this.file)
    })
    return this.writing
  }

  getSession(id: string): SessionSyncState | undefined {
    return this.sessions.get(id)
  }

  entries(): IterableIterator<[string, SessionSyncState]> {
    return this.sessions.entries()
  }

  async putSession(id: string, state: SessionSyncState): Promise<void> {
    this.sessions.set(id, state)
    await this.persist()
  }

  getGlobal(): GlobalState {
    return this.global
  }

  async setGlobal(patch: Partial<GlobalState>): Promise<void> {
    this.global = { ...this.global, ...patch }
    await this.persist()
  }

  async close(): Promise<void> {
    await this.writing
  }
}
