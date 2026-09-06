/**
 * sessionPersistence 双版本适配层（docs/02 §6 集成面的版本兼容）。
 *
 * 背景：dsh 0.1.3-alpha.1 起 SessionPersistence 收敛了消费者 API——
 * `listSnapshots()` 并入 `list()`（直接返回带 revision 的快照），`locate()`
 * 被私有化（上游注释明确「日志访问走 session handle 的 read」）。插件按
 * 发布版 rc.1 的 API 编写，这里在运行时探测宿主形态并归一到引擎/恢复
 * 消费的 SessionPersistenceLike 端口：
 * - v0（rc.1 及以前）：listSnapshots/list/locate 原样透传；
 * - v1（0.1.3-alpha.1 起）：list() 即快照枚举；落位路径无法再问宿主，
 *   按 jsonl 后端的磁盘布局推导（<root>/<projectKey>/<id>/session[.vN].jsonl[.zstd]，
 *   vN 为会话格式代（v0 无标签），复刻 dsh format.ts 的 projectKey/encodeSegment
 *   与 session-format filename.ts 的代命名）。
 */
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { SessionHeaderLike, SessionLocationLike, SessionSnapshotLike } from '../dsh-types.js'

/**
 * 宿主原始形态：v0 时 `listSnapshots` 存在且 `list()` 返回 header 数组；
 * v1（0.1.3-alpha.1+）时 `listSnapshots` 缺失且 `list()` 返回快照数组。
 * 运行时以 `listSnapshots` 探测分支，`list()` 元素类型按分支收窄。
 */
interface RawPersistence {
  listSnapshots?(signal?: AbortSignal): Promise<SessionSnapshotLike[]>
  list(signal?: AbortSignal): Promise<readonly unknown[]>
  locate?(meta: SessionHeaderLike): SessionLocationLike | undefined
}

/**
 * 复刻 dsh session-persistence-jsonl 的 projectKey（format.ts:228）：
 * 分隔符折叠为 `-`，不安全码位转 `~XXXX`（大写十六进制 4 位），
 * 首部 `-` 剥离、截断到 251 码位、整体包 `--…--`。
 */
export function projectKeyOf(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let i = 0; i < cwd.length; i++) {
    const code = cwd.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch === '/' || ch === '\\' || ch === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
    } else if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      readable += ch
      separatorRun = false
    } else {
      readable += '~' + code.toString(16).toUpperCase().padStart(4, '0')
      separatorRun = false
    }
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, 251)}--`
}

/**
 * 复刻 dsh 的 encodeSegment（format.ts:202）：安全字符直通，其余转
 * `~XXXX`；`.`/`..` 整体转义。会话 id（session-<uuid>）实际恒为直通。
 */
export function encodeSegmentOf(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let i = 0; i < raw.length; i++) {
    const code = raw.charCodeAt(i)
    const ch = String.fromCharCode(code)
    if (ch !== '~' && /^[A-Za-z0-9._-]$/.test(ch)) {
      out += ch
    } else {
      out += '~' + code.toString(16).toUpperCase().padStart(4, '0')
    }
  }
  return out
}

/**
 * 推导 jsonl 后端的会话目录（不动文件系统）：无 cwd 落 `_no-cwd`。
 * 与 dsh projectDir/sessionDir（format.ts:257/270）同构。
 */
export function sessionDirOf(root: string, cwd: string | undefined, id: string): string {
  const project = cwd === undefined ? join(root, '_no-cwd') : join(root, projectKeyOf(cwd))
  return join(project, encodeSegmentOf(id))
}

/**
 * 推导会话 artifact 位置：候选按优先级探测——当前代（header.version）zstd →
 * v0 旧形态 zstd（rc.1 数据 / 代升级残留）→ 当前代明文 → v0 明文；都不存在则
 * 推导当前代 zstd 路径（调用方按 ENOENT 语义处理未物化会话）。
 */
function locateDerived(root: string, meta: SessionHeaderLike): SessionLocationLike {
  const dir = sessionDirOf(root, meta.cwd, meta.id)
  const candidates = [
    join(dir, `${logBasenameOf(meta.version)}.zstd`),
    join(dir, 'session.jsonl.zstd'),
    join(dir, logBasenameOf(meta.version)),
    join(dir, 'session.jsonl'),
  ]
  for (const candidate of candidates) {
    if (existsSync(candidate)) return { kind: 'jsonl', path: candidate }
  }
  return { kind: 'jsonl', path: candidates[0] }
}

/**
 * 当前代日志 basename（复刻 dsh session-format filename.ts:14）：
 * version 0 保持 `session.jsonl`，之后每代带小写 `.vN` 段。
 */
function logBasenameOf(version: number): string {
  return version === 0 ? 'session.jsonl' : `session.v${version}.jsonl`
}

/**
 * 把宿主 sessionPersistence 归一为引擎/恢复消费的端口。
 * @param raw - ctx.sessionPersistence 原始服务（v0 或 v1 形态）。
 * @param sessionsRoot - jsonl 后端 root（dsh bundle 恒配 dshHomePath('sessions')）。
 * @returns 端口对象；v0 的 locate 缺失且非 v1 布局可推导时 listSnapshots 仍可用。
 */
export function createPersistencePort(raw: RawPersistence, sessionsRoot: string): {
  listSnapshots(signal?: AbortSignal): Promise<SessionSnapshotLike[]>
  list(signal?: AbortSignal): Promise<SessionHeaderLike[]>
  locate(meta: SessionHeaderLike): SessionLocationLike | undefined
} {
  const v0 = typeof raw.listSnapshots === 'function'
  return {
    async listSnapshots(signal?: AbortSignal): Promise<SessionSnapshotLike[]> {
      if (v0) return await raw.listSnapshots!(signal)
      // v1：list() 即快照枚举（header + revision）
      return (await raw.list(signal)) as SessionSnapshotLike[]
    },
    async list(signal?: AbortSignal): Promise<SessionHeaderLike[]> {
      const entries = await raw.list(signal)
      // v0 返回 header 数组，v1 返回快照数组——按形态归一为 header
      return v0
        ? entries as SessionHeaderLike[]
        : (entries as SessionSnapshotLike[]).map((snapshot) => snapshot.header)
    },
    locate(meta: SessionHeaderLike): SessionLocationLike | undefined {
      if (v0) return raw.locate?.(meta)
      return locateDerived(sessionsRoot, meta)
    },
  }
}
