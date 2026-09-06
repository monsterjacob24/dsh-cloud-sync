/**
 * M3 e2e 驱动插件：常驻 dsh 进程，监听 $E2E_WORK/trigger 文件出现，
 * 创建会话 m3-session-1、写入标记事件并 flush，然后写 $E2E_WORK/created 确认。
 * 用于验证设置卡「自动上传」开关的真实生效（关→不同步，开→补传）。
 */
import { existsSync, writeFileSync, rmSync } from 'node:fs'
import path from 'node:path'
import type { Context } from '@deepseek-ai/cordis'

export const name = 'm3-driver'
export const inject = ['sessions']

interface SessionLike {
  append(type: string, data: unknown): unknown
}

interface SessionsLike {
  create(id: string, options?: { meta?: { cwd?: string } }): SessionLike
  flush(session: SessionLike): Promise<boolean>
}

export async function apply(ctx: Context): Promise<void> {
  const work = process.env.E2E_WORK
  // 非 e2e 编排环境（手动 --patch 调试）没有 E2E_WORK：静默跳过，不挂载触发器
  if (!work) {
    console.log('M3-DRIVER-DISABLED (E2E_WORK 未设置)')
    return
  }
  const trigger = path.join(work, 'trigger')
  const created = path.join(work, 'created')
  const sessions = (ctx as unknown as { sessions: SessionsLike }).sessions

  const timer = setInterval(() => {
    if (!existsSync(trigger)) return
    rmSync(trigger)
    const session = sessions.create('m3-session-1', { meta: { cwd: '/tmp' } })
    session.append('session/title', { title: 'M3 开关验收会话', messageSeqs: [], source: { kind: 'user' } })
    session.append('turn/end', { turn: 0, reason: 'complete' })
    void sessions.flush(session).then(() => {
      writeFileSync(created, String(Date.now()))
      console.log('M3-DRIVER-CREATED')
    })
  }, 300)
  timer.unref?.()
  console.log('M3-DRIVER-READY')
}
