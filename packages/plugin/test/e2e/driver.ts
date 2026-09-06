/**
 * e2e 驱动插件：在真实 dsh 进程内创建一个会话、写事件、flush，
 * 然后轮询云端直到 log.enc / meta.enc 出现（PASS）或超时（FAIL）。
 * 仅用于 M2 验收，不随包发布。
 */
import type { Context } from '@deepseek-ai/cordis'

export const name = 'e2e-driver'
export const inject = ['sessions']

interface SessionLike {
  append(type: string, data: unknown): unknown
}

interface SessionsLike {
  create(id: string, options?: { meta?: { cwd?: string } }): SessionLike
  flush(session: SessionLike): Promise<boolean>
}

export async function apply(ctx: Context): Promise<void> {
  const serverUrl = process.env.E2E_SERVER_URL!
  const token = process.env.E2E_TOKEN!
  const device = process.env.E2E_DEVICE!
  const cwd = process.env.E2E_CWD!

  const sessions = (ctx as unknown as { sessions: SessionsLike }).sessions
  const session = sessions.create('e2e-session-1', { meta: { cwd } })
  session.append('session/title', { title: 'E2E 验收会话', messageSeqs: [], source: { kind: 'user' } })
  session.append('turn/end', { turn: 0, reason: 'complete' })
  session.append('session/title', { title: 'E2E 验收会话 v2', messageSeqs: [], source: { kind: 'user' } })
  await sessions.flush(session)

  const deadline = Date.now() + 20000
  let lastKeys: string[] = []
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${serverUrl}/v1/sessions`, {
        headers: { authorization: `Bearer ${token}` },
      })
      const { objects } = (await res.json()) as { objects: { key: string; size: number }[] }
      lastKeys = objects.map((o) => o.key)
      const log = objects.find((o) => o.key === `sessions/${device}/e2e-session-1.log.enc`)
      const meta = objects.find((o) => o.key === `sessions/${device}/e2e-session-1.meta.enc`)
      if (log && meta && log.size > 0 && meta.size > 0) {
        console.log(`E2E-PASS log=${log.size}B meta=${meta.size}B keys=${lastKeys.join(',')}`)
        process.exit(0)
      }
    } catch {
      // 服务端尚未就绪，继续等
    }
    await new Promise((r) => setTimeout(r, 500))
  }
  console.error(`E2E-FAIL: cloud objects missing, last list=${lastKeys.join(',')}`)
  process.exit(1)
}
