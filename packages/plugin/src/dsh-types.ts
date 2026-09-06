/**
 * dsh 服务的最小结构类型（本地声明，不依赖未发布的 dsh 内部类型包）。
 * 集成面收敛在 docs/02 §6 列出的公开方法上；字段与 dsh 源码逐一核对过。
 */
// 必须 import 被扩展的模块，否则下面的 declare module 会变成模块替换而非合并
import type {} from '@deepseek-ai/cordis'

/** @deepseek-ai/dsh-session-persistence 的 SessionHeader（packages/core/session/src/types.ts:56）。 */
export interface SessionHeaderLike {
  readonly version: number
  readonly id: string
  readonly createdAt: number
  readonly cwd?: string
  readonly parentSession?: string
  readonly seedLength?: number
  readonly origin?: 'subagent'
  readonly delegationDepth?: number
  readonly agentPreset?: string
}

export interface SessionSnapshotLike {
  readonly header: SessionHeaderLike
  /** 后端持有的不透明 revision 令牌，变更必变 */
  readonly revision: string
}

/** locate() 的返回；无单文件 artifact 的后端（如 SQLite）返回 undefined。 */
export interface SessionLocationLike {
  readonly kind: string
  readonly path: string
}

/**
 * 引擎/恢复消费的持久化端口。宿主可能是 v0（rc.1：listSnapshots/locate 齐备）
 * 或 v1（0.1.3-alpha.1+：list() 返回快照、locate 私有化），由
 * sync/persistence-port.ts 做运行时归一；本接口始终是 v0 形态。
 */
export interface SessionPersistenceLike {
  listSnapshots(signal?: AbortSignal): Promise<SessionSnapshotLike[]>
  list(signal?: AbortSignal): Promise<SessionHeaderLike[]>
  locate(meta: SessionHeaderLike): SessionLocationLike | undefined
}

/** @deepseek-ai/dsh-workspace 的 Workspace（恢复挂载用到 attachSession）。 */
export interface WorkspaceLike {
  readonly path: string
  /** 把会话记入本工作区成员（cwd 校验：realpath 后须等于工作区 path） */
  attachSession(sessionId: string): Promise<void>
}

export interface WorkspaceRegistryLike {
  list(): WorkspaceLike[]
  /** 按本机 canonical path 查找已有 workspace；不存在返回 undefined */
  resolveByPath(path: string): Promise<WorkspaceLike | undefined>
  /** 为已存在目录新建 workspace（realpath + isDirectory 校验，目录不存在会抛） */
  create(path: string, title?: string): Promise<WorkspaceLike>
}

/** settings 服务的最小切面（@deepseek-ai/dsh-settings 的 installSection）。 */
export interface SettingsSectionHooksLike<T> {
  setSource(source: () => T): void
  onChange(): void
  validate?(value: T): void
}

export interface SettingsLike {
  installSection<T>(owner: unknown, ns: string, schema: unknown, entry: T, hooks: SettingsSectionHooksLike<T>): void
  /** merge 写 user 层并持久化；Host 状态回写走这条通道（settings/src/index.ts:562） */
  update(ns: string, patch: object): Promise<void>
}

declare module '@deepseek-ai/cordis' {
  interface Context {
    sessionPersistence: SessionPersistenceLike
    settings?: SettingsLike
    workspaceRegistry?: WorkspaceRegistryLike
    dshHomePath?: (...segments: string[]) => string
  }

  /**
   * dsh 的 durability checkpoint 事件（core/session Events，包只做结构声明）：
   * 缓冲事件落盘时触发，插件用它做 flush 驱动的变更发现（M5，见 sync/engine
   * requestScan）。真实载荷是 Session 对象，插件只关心触发时机。
   */
  interface Events {
    'session/flush'(session: { id: string }): void
  }
}
