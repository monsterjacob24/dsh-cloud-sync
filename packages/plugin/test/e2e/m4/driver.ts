/**
 * M4 e2e 驱动插件：常驻 dsh 进程，文件触发器模式驱动恢复流程验收。
 *
 * 触发器（$E2E_WORK 下，由 run.sh 创建）：
 *   restore-list  出现 → 向 'cloud-sync-status' 写 restoreListRequestedAt=Date.now()
 *                 → 轮询读回 restoreCatalogJson 直到 at 回显 → 写 catalog.json
 *   restore-run   出现（内容为 RestoreRequest JSON，at 由编排脚本生成）→
 *                 写 restoreRequestJson → 轮询 restoreResultJson 直到 at 回显 →
 *                 写 result.json（含 pathMappingsJson 快照）→
 *                 轮询 persistence.list() 确认被恢复会话已发现 →
 *                 写 discovered.json（含 locate() 落位路径）
 * E2E_WORK 未设置（手动 --patch 调试）时静默跳过。
 *
 * settings 读回方式：SettingsProvider.get(ns) 返回注册 namespace 的当前解析值
 * （dsh packages/settings/settings/src/index.ts:546），无需读 DSH_HOME 下的
 * 持久化文件；写走同一个 update(ns, patch)（Host 回写用的也是它）。
 */
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'm4-driver'
export const inject = ['settings', 'sessionPersistence']

/** 触发器消费的 settings namespace（与 Host 的 StatusConfig 一致）。 */
const NS = 'cloud-sync-status'

interface SettingsLike {
  update(ns: string, patch: object): Promise<void>
  get(ns: string): unknown
}

interface HeaderLike {
  id: string
  cwd?: string
}

interface PersistenceLike {
  list(): Promise<HeaderLike[]>
  locate(meta: HeaderLike): { kind: string; path: string } | undefined
}

interface WorkspaceEntityLike {
  readonly path: string
  readonly sessionIds: readonly string[]
}

interface WorkspaceRegistryLike {
  list(): WorkspaceEntityLike[]
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms))

export async function apply(ctx: Context): Promise<void> {
  const work = process.env.E2E_WORK
  // 非 e2e 编排环境（手动 --patch 调试）没有 E2E_WORK：静默跳过，不挂载触发器
  if (!work) {
    console.log('M4-DRIVER-DISABLED (E2E_WORK 未设置)')
    return
  }
  const settings = (ctx as unknown as { settings: SettingsLike }).settings
  const persistence = (ctx as unknown as { sessionPersistence: PersistenceLike }).sessionPersistence

  /** 轮询读回 status namespace，直到 pred 命中或超时。 */
  async function waitStatus(pred: (status: Record<string, unknown>) => string | undefined, timeoutMs: number): Promise<string> {
    const deadline = Date.now() + timeoutMs
    for (;;) {
      const status = settings.get(NS) as Record<string, unknown> | undefined
      const hit = status === undefined ? undefined : pred(status)
      if (hit !== undefined) return hit
      if (Date.now() > deadline) throw new Error('等待状态回读超时')
      await sleep(200)
    }
  }

  /** 取 JSON 字符串字段并等 at 回显（parse 失败按未命中继续等）。 */
  function echoed(field: string, at: number): (status: Record<string, unknown>) => string | undefined {
    return (status) => {
      const raw = status[field]
      if (typeof raw !== 'string' || raw === '') return undefined
      try {
        return (JSON.parse(raw) as { at?: number }).at === at ? raw : undefined
      } catch {
        return undefined
      }
    }
  }

  async function handleRestoreList(): Promise<void> {
    const at = Date.now()
    await settings.update(NS, { restoreListRequestedAt: at })
    const catalog = await waitStatus(echoed('restoreCatalogJson', at), 30_000)
    writeFileSync(path.join(work!, 'catalog.json'), catalog)
    console.log('M4-DRIVER-CATALOG')
  }

  async function handleRestoreRun(requestJson: string): Promise<void> {
    const request = JSON.parse(requestJson) as { at: number; items: { sessionId: string }[] }
    await settings.update(NS, { restoreRequestJson: requestJson })
    const resultRaw = await waitStatus(echoed('restoreResultJson', request.at), 60_000)
    const status = settings.get(NS) as Record<string, unknown>
    const mappings = typeof status.pathMappingsJson === 'string' ? JSON.parse(status.pathMappingsJson) : []
    writeFileSync(
      path.join(work!, 'result.json'),
      JSON.stringify({ result: JSON.parse(resultRaw), pathMappings: mappings }),
    )
    console.log('M4-DRIVER-RESULT')

    // 落位发现：sessionQuery 的 list 走 persistence.list() 扫盘，文件就位即被发现
    const sessionId = request.items[0]?.sessionId ?? ''
    const deadline = Date.now() + 15_000
    for (;;) {
      const found = (await persistence.list()).find((header) => header.id === sessionId)
      if (found) {
        const location = persistence.locate(found)
        writeFileSync(
          path.join(work!, 'discovered.json'),
          JSON.stringify({ found: true, header: found, path: location?.path ?? null }),
        )
        console.log('M4-DRIVER-DISCOVERED')
        break
      }
      if (Date.now() > deadline) throw new Error(`会话 ${sessionId} 恢复后未被 persistence.list() 发现`)
      await sleep(300)
    }

    // workspace 成员关系：恢复挂载后会话应出现在 targetCwd 对应的工作区成员里
    // （web 侧边栏按此分组；entity.sessionIds 已按 canonical cwd 过滤）。
    // ctx.get 走全局服务表读取，不依赖本插件 inject 声明
    const registry = ctx.get('workspaceRegistry') as WorkspaceRegistryLike | undefined
    if (!registry) throw new Error('workspaceRegistry 未挂载，无法断言 workspace 成员关系')
    const wsDeadline = Date.now() + 15_000
    for (;;) {
      const workspace = registry.list().find((candidate) => candidate.sessionIds.includes(sessionId))
      if (workspace) {
        writeFileSync(path.join(work!, 'workspace.json'), JSON.stringify({ attached: true, path: workspace.path }))
        console.log('M4-DRIVER-WORKSPACE')
        return
      }
      if (Date.now() > wsDeadline) throw new Error(`会话 ${sessionId} 未挂进任何 workspace`)
      await sleep(300)
    }
  }

  // cloud-sync 的 namespace 注册先于本插件（patch 顺序），但仍防御性等到可见再就绪，
  // 否则 update() 会因 namespace 未注册而抛
  {
    const deadline = Date.now() + 30_000
    while (settings.get(NS) === undefined) {
      if (Date.now() > deadline) {
        console.log('M4-DRIVER-ERROR cloud-sync-status namespace 未注册')
        return
      }
      await sleep(200)
    }
  }

  let busy = false
  const timer = setInterval(() => {
    if (busy) return
    const listTrigger = path.join(work, 'restore-list')
    const runTrigger = path.join(work, 'restore-run')
    let task: Promise<void> | undefined
    if (existsSync(listTrigger)) {
      rmSync(listTrigger)
      task = handleRestoreList()
    } else if (existsSync(runTrigger)) {
      const content = readFileSync(runTrigger, 'utf8')
      rmSync(runTrigger)
      task = handleRestoreRun(content)
    }
    if (task) {
      busy = true
      void task
        .catch((error: unknown) => console.log(`M4-DRIVER-ERROR ${String(error)}`))
        .finally(() => {
          busy = false
        })
    }
  }, 300)
  timer.unref?.()
  writeFileSync(path.join(work, 'driver-ready'), String(Date.now()))
  console.log('M4-DRIVER-READY')
}
