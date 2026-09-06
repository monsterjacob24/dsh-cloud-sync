import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, it } from 'node:test'
import { decryptLog, decryptMeta, deriveKey, generateSalt, KDF_DEFAULTS } from '../crypto/envelope.ts'
import type { SessionHeaderLike, SessionPersistenceLike, SessionSnapshotLike } from '../dsh-types.ts'
import { SyncEngine, logKey, metaKey, type SyncEvent } from './engine.ts'
import { ZSTD_CHECKSUM_OPTIONS, zstdCompressAsync } from './frames.ts'
import { ProtocolError, type RemoteObject, type SyncClient } from './http-client.ts'
import { JsonFileStateStore } from './state.ts'

const PASSPHRASE = 'test passphrase'
const DEVICE = 'test-device'
const SALT = generateSalt()
const KEY = deriveKey(PASSPHRASE, SALT, KDF_DEFAULTS)

/** 内存版 protocol v1 哑存储（与 packages/server 同语义）。 */
class FakeServer {
  objects = new Map<string, Buffer>()
  /** 模拟网络/服务端故障：overwrite/append 一律抛非 409 错误 */
  failUploads = false

  asClient(): SyncClient {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const server = this
    return {
      async list(prefix?: string): Promise<RemoteObject[]> {
        return [...server.objects.entries()]
          .filter(([key]) => !prefix || key.startsWith(prefix))
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([key, content]) => ({ key, size: content.length, revision: 'r', lastModified: '' }))
      },
      async download(key: string): Promise<Buffer> {
        const content = server.objects.get(key)
        if (!content) throw new ProtocolError(404, 'not found')
        return content
      },
      async downloadRange(key: string, start: number, end: number): Promise<Buffer> {
        const content = server.objects.get(key)
        if (!content) throw new ProtocolError(404, 'not found')
        return content.subarray(start, end + 1)
      },
      async overwrite(key: string, content: Buffer): Promise<void> {
        if (server.failUploads) throw new Error('simulated network failure')
        server.objects.set(key, Buffer.from(content))
      },
      async append(key: string, offset: number, content: Buffer): Promise<void> {
        if (server.failUploads) throw new Error('simulated network failure')
        const current = server.objects.get(key) ?? Buffer.alloc(0)
        if (offset !== current.length) {
          throw new ProtocolError(409, 'offset mismatch', current.length)
        }
        server.objects.set(key, Buffer.concat([current, content]))
      },
      async delete(key: string): Promise<void> {
        server.objects.delete(key)
      },
      async ping(): Promise<void> {},
    } as unknown as SyncClient
  }
}

function header(id: string, cwd = '/proj'): SessionHeaderLike {
  return { version: 0, id, createdAt: 1000, cwd }
}

async function frameOf(lines: string[]): Promise<Buffer> {
  return zstdCompressAsync(Buffer.from(lines.join('\n') + '\n', 'utf8'), ZSTD_CHECKSUM_OPTIONS)
}

async function headerFrame(h: SessionHeaderLike): Promise<Buffer> {
  return frameOf([
    JSON.stringify({ type: 'session', version: h.version, id: h.id, createdAt: h.createdAt, cwd: h.cwd, delegationDepth: 0 }),
  ])
}

/** 假 persistence：会话文件在临时目录，revision 手动推进。 */
class FakePersistence implements SessionPersistenceLike {
  revisions = new Map<string, number>()
  files = new Map<string, string>()

  constructor(private dir: string) {}

  async addSession(h: SessionHeaderLike, frames: Buffer[]): Promise<void> {
    const file = path.join(this.dir, `${h.id}.zstd`)
    await fsp.writeFile(file, Buffer.concat(frames))
    this.files.set(h.id, file)
    this.revisions.set(h.id, 1)
  }

  async append(h: SessionHeaderLike, frames: Buffer[]): Promise<void> {
    await fsp.appendFile(this.files.get(h.id)!, Buffer.concat(frames))
    this.revisions.set(h.id, this.revisions.get(h.id)! + 1)
  }

  listSnapshots(): Promise<SessionSnapshotLike[]> {
    return Promise.resolve(
      [...this.files.keys()].map((id) => ({
        header: header(id),
        revision: `rev-${this.revisions.get(id)}`,
      })),
    )
  }

  async list(): Promise<SessionHeaderLike[]> {
    return [...this.files.keys()].map((id) => header(id))
  }

  locate(meta: SessionHeaderLike) {
    const file = this.files.get(meta.id)
    return file ? { kind: 'file', path: file } : undefined
  }
}

async function makeEngine(
  tmp: string,
  server: FakeServer,
  persistence: FakePersistence,
  events: SyncEvent[] = [],
  opts: { autoUpload?: boolean } = {},
) {
  const state = await JsonFileStateStore.open(path.join(tmp, 'state'))
  const engine = new SyncEngine({
    client: server.asClient(),
    key: KEY,
    salt: SALT,
    device: DEVICE,
    state,
    persistence,
    getConfig: () => ({ autoUpload: opts.autoUpload ?? true, uploadDebounceMs: 5 }),
    onEvent: (e) => events.push(e),
  })
  return { engine, state }
}

async function tmpdir(): Promise<string> {
  return fsp.mkdtemp(path.join(os.tmpdir(), 'dcs-engine-'))
}

describe('SyncEngine 上行', () => {
  it('首传：云端出现 log.enc + meta.enc，密文可解回原文件', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_1')
    const frames = [
      await headerFrame(h),
      await frameOf([
        '{"type":"user/message","seq":0,"time":100,"data":{}}',
        '{"type":"session/title","seq":1,"time":150,"data":{"title":"整理结构","messageSeqs":[0],"source":{"kind":"user"}}}',
      ]),
    ]
    const fileBytes = Buffer.concat(frames)
    await persistence.addSession(h, frames)

    const { engine } = await makeEngine(tmp, server, persistence)
    await engine.start()
    await engine.flush()

    const logBytes = server.objects.get(logKey(DEVICE, 's_1'))
    assert.ok(logBytes, 'log.enc 应存在')
    assert.deepEqual(decryptLog(KEY, 's_1', logBytes!), fileBytes)

    const metaBytes = server.objects.get(metaKey(DEVICE, 's_1'))
    assert.ok(metaBytes, 'meta.enc 应存在')
    const meta = decryptMeta(KEY, 's_1', metaBytes!)
    assert.equal(meta.title, '整理结构')
    assert.equal(meta.eventCount, 2)
    assert.equal(meta.updatedAt, 150)
    assert.equal(meta.cwd, '/proj')
    assert.equal(meta.formatVersion, 0)
    assert.equal(meta.device, DEVICE)

    // 密文不含明文标题
    assert.equal(logBytes!.includes(Buffer.from('整理结构', 'utf8')), false)
    await engine.dispose()
  })

  it('未物化会话（v1 list 含无文件项）：ENOENT 静默跳过，不算失败不重试', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_ghost')
    await persistence.addSession(h, [await headerFrame(h)])
    // 模拟 v1「已创建未物化」：locate 有路径、磁盘无文件
    await fsp.rm(persistence.files.get('s_ghost')!)

    const { engine, state } = await makeEngine(tmp, server, persistence)
    const result = await engine.syncAllNow()

    assert.equal(result.failed, 0)
    assert.equal(server.objects.size, 0, '不应上传任何对象')
    assert.equal(state.getSession('s_ghost')?.localRevision, 'rev-1', 'revision 已记录，物化变更后才会重新调度')
    await engine.dispose()
  })

  it('布局失配（目录里有 canonical 日志但 locate 指错路径）：报错可见而非静默成功', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_mismatch')
    await persistence.addSession(h, [await headerFrame(h)])
    // locate 指向的文件不存在，但其目录里出现 canonical 形态日志（如上游
    // 再改代命名）：这是失配，不是未物化
    await fsp.rm(persistence.files.get('s_mismatch')!)
    await fsp.writeFile(path.join(tmp, 'session.v9.jsonl.zstd'), 'x')

    const { engine } = await makeEngine(tmp, server, persistence)
    const result = await engine.syncAllNow()

    assert.equal(result.failed, 1, '失配必须计入失败暴露给用户')
    assert.match(result.firstError ?? '', /layout mismatch/)
    await engine.dispose()
  })

  it('污染自愈：uploadedBytes=0 但 localRevision 已记（曾被静默跳过）的会话重新上传', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_poisoned')
    await persistence.addSession(h, [await headerFrame(h)])

    const { engine, state } = await makeEngine(tmp, server, persistence)
    // 预置被旧 bug 污染的条目：从未上传任何字节，revision 却记为当前值
    await state.putSession('s_poisoned', {
      uploadedBytes: 0, remoteBytes: 0, lastSegmentIndex: -1, lastTag: '',
      localRevision: 'rev-1', eventCount: 0, updatedAt: 0, status: 'ok',
    })
    const result = await engine.syncAllNow()

    assert.equal(result.ok, 1, '污染条目必须视为待同步并成功上传')
    assert.ok(server.objects.size > 0, '云端应出现对象')
    await engine.dispose()
  })

  it('恢复抑制（restoredAt）不被自愈判定误伤：revision 未变时不回传', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_restored')
    await persistence.addSession(h, [await headerFrame(h)])

    const { engine, state } = await makeEngine(tmp, server, persistence)
    await state.putSession('s_restored', {
      uploadedBytes: 0, remoteBytes: 0, lastSegmentIndex: -1, lastTag: '',
      localRevision: 'rev-1', restoredAt: Date.now(), eventCount: 0, updatedAt: 0, status: 'ok',
    })
    const result = await engine.syncAllNow()

    assert.equal(result.ok, 0, '恢复落位未续写的会话不应回传')
    assert.equal(server.objects.size, 0)
    await engine.dispose()
  })

  it('增量：第二轮只追加新增帧，云端解出完整文件', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_2')
    await persistence.addSession(h, [await headerFrame(h), await frameOf(['{"type":"user/message","seq":0,"time":100,"data":{}}'])])

    const { engine, state } = await makeEngine(tmp, server, persistence)
    await engine.start()
    await engine.flush()
    const afterFirst = server.objects.get(logKey(DEVICE, 's_2'))!.length

    await persistence.append(h, [
      await frameOf(['{"type":"assistant/message","seq":1,"time":200,"data":{}}']),
      await frameOf(['{"type":"session/title","seq":2,"time":250,"data":{"title":"新标题","messageSeqs":[],"source":{"kind":"fallback"}}}']),
    ])
    await engine.scan()
    await engine.flush()

    const finalBytes = server.objects.get(logKey(DEVICE, 's_2'))!
    assert.ok(finalBytes.length > afterFirst, '对象应增长')
    const localFile = await fsp.readFile(persistence.files.get('s_2')!)
    assert.deepEqual(decryptLog(KEY, 's_2', finalBytes), localFile)

    const meta = decryptMeta(KEY, 's_2', server.objects.get(metaKey(DEVICE, 's_2'))!)
    assert.equal(meta.title, '新标题')
    assert.equal(meta.eventCount, 3)
    assert.equal(state.getSession('s_2')!.lastSegmentIndex, 1)
    await engine.dispose()
  })

  it('明文 profile：检测后跳过并标记 skipped-plain', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_3')
    const file = path.join(tmp, 's_3.zstd')
    await fsp.writeFile(file, '{"type":"session","version":0,"id":"s_3","createdAt":1,"delegationDepth":0}\n')
    persistence.files.set('s_3', file)
    persistence.revisions.set('s_3', 1)

    const events: SyncEvent[] = []
    const { engine, state } = await makeEngine(tmp, server, persistence, events)
    await engine.start()
    await engine.flush()

    assert.equal(server.objects.size, 0)
    assert.equal(state.getSession('s_3')!.status, 'skipped-plain')
    assert.ok(events.some((e) => e.kind === 'skipped-plain'))
    await engine.dispose()
  })

  it('409 幂等：上次上传成功但 state 未推进 → 不重传，仅推进 state', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_4')
    await persistence.addSession(h, [await headerFrame(h), await frameOf(['{"type":"user/message","seq":0,"time":100,"data":{}}'])])

    const { engine, state } = await makeEngine(tmp, server, persistence)
    await engine.start()
    await engine.flush()

    // 第一轮结束时的 state（崩溃点：第二轮 append 成功但 state 未写盘前的样子）
    const afterFirst = structuredClone(state.getSession('s_4')!)

    // 第二轮：新增一帧并上传成功
    await persistence.append(h, [await frameOf(['{"type":"assistant/message","seq":1,"time":200,"data":{}}'])])
    await engine.scan()
    await engine.flush()
    const logAfterSecond = Buffer.from(server.objects.get(logKey(DEVICE, 's_4'))!)

    // 模拟崩溃：state 回滚到第一轮末（云端其实已有第二段）
    await state.putSession('s_4', afterFirst)
    await engine.scan()
    await engine.flush()

    // 幂等路径：append 409 → 末段链式校验通过 → 仅推进 state，不重复上传
    const afterIdempotent = Buffer.from(server.objects.get(logKey(DEVICE, 's_4'))!)
    assert.deepEqual(afterIdempotent, logAfterSecond, '幂等路径不得重复上传字节')
    assert.equal(state.getSession('s_4')!.status, 'ok')
    assert.equal(state.getSession('s_4')!.lastSegmentIndex, 1)
    await engine.dispose()
  })

  it('409 冲突：服务端末段校验不过 → conflict，停止同步且云端不被覆写', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_5')
    await persistence.addSession(h, [await headerFrame(h), await frameOf(['{"type":"user/message","seq":0,"time":100,"data":{}}'])])

    const events: SyncEvent[] = []
    const { engine, state } = await makeEngine(tmp, server, persistence, events)
    await engine.start()
    await engine.flush()

    // 同名设备的另一台机器写入了不同字节
    server.objects.set(logKey(DEVICE, 's_5'), Buffer.concat([server.objects.get(logKey(DEVICE, 's_5'))!, Buffer.from('foreign-bytes')]))

    await persistence.append(h, [await frameOf(['{"type":"assistant/message","seq":1,"time":200,"data":{}}'])])
    await engine.scan()
    await engine.flush()

    assert.equal(state.getSession('s_5')!.status, 'conflict')
    assert.ok(events.some((e) => e.kind === 'conflict'))
    // 云端尾部仍是 foreign-bytes（未被覆写）
    const remote = server.objects.get(logKey(DEVICE, 's_5'))!
    assert.ok(remote.subarray(remote.length - 13).equals(Buffer.from('foreign-bytes')))
    await engine.dispose()
  })

  it('state 丢失回退全量重传', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_6')
    await persistence.addSession(h, [await headerFrame(h), await frameOf(['{"type":"user/message","seq":0,"time":100,"data":{}}'])])

    const { engine } = await makeEngine(tmp, server, persistence)
    await engine.start()
    await engine.flush()
    await engine.dispose()

    // 换设备名（避免幂等 409 路径），删掉 state 文件，重跑 → 全量覆写
    await fsp.rm(path.join(tmp, 'state'), { recursive: true, force: true })
    const state2 = await JsonFileStateStore.open(path.join(tmp, 'state'))
    const engine2 = new SyncEngine({
      client: server.asClient(),
      key: KEY,
      salt: SALT,
      device: 'other-device',
      state: state2,
      persistence,
      getConfig: () => ({ autoUpload: true, uploadDebounceMs: 5 }),
    })
    await engine2.start()
    await engine2.flush()

    const remote = server.objects.get(logKey('other-device', 's_6'))!
    const localFile = await fsp.readFile(persistence.files.get('s_6')!)
    assert.deepEqual(decryptLog(KEY, 's_6', remote), localFile)
    await engine2.dispose()
  })

  it('autoUpload=false 时 scan() 不调度', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_7')
    await persistence.addSession(h, [await headerFrame(h), await frameOf(['{"type":"user/message","seq":0,"time":100,"data":{}}'])])

    const { engine } = await makeEngine(tmp, server, persistence, [], { autoUpload: false })
    await engine.start() // start 内部走 scan()，应被 autoUpload 早退
    await engine.scan()
    await engine.flush()

    assert.equal(server.objects.size, 0)
    await engine.dispose()
  })

  it('syncAllNow：autoUpload=false 也能上传（用户显式触发无视开关）', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_8')
    await persistence.addSession(h, [await headerFrame(h), await frameOf(['{"type":"user/message","seq":0,"time":100,"data":{}}'])])

    const { engine } = await makeEngine(tmp, server, persistence, [], { autoUpload: false })
    await engine.start()
    assert.equal(server.objects.size, 0, 'scan 被 autoUpload=false 挡住')

    const result = await engine.syncAllNow()
    assert.deepEqual(result, { ok: 1, failed: 0, firstError: undefined })
    const remote = server.objects.get(logKey(DEVICE, 's_8'))
    assert.ok(remote, 'syncAllNow 应已上传 log.enc')
    const localFile = await fsp.readFile(persistence.files.get('s_8')!)
    assert.deepEqual(decryptLog(KEY, 's_8', remote!), localFile)

    // 第二轮：无变更 → 无需同步，ok/failed 均为 0
    const again = await engine.syncAllNow()
    assert.deepEqual(again, { ok: 0, failed: 0, firstError: undefined })
    await engine.dispose()
  })

  // ---- 退避与变更重置（docs/02 §10：指数退避，下一次会话变更重置退避） ----

  it('上传失败进入退避：同一 revision 重试被退避窗口挡住', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_b1')
    await persistence.addSession(h, [await headerFrame(h)])

    const events: SyncEvent[] = []
    const { engine, state } = await makeEngine(tmp, server, persistence, events)
    server.failUploads = true
    await engine.start()
    await engine.flush()
    assert.equal(state.getSession('s_b1')!.status, 'error')
    assert.equal(events.filter((e) => e.kind === 'error').length, 1, '首轮失败记一次错误')

    // 退避 1s 未到：同 revision 再 scan+flush 不得产生新的失败事件
    await engine.scan()
    await engine.flush()
    assert.equal(events.filter((e) => e.kind === 'error').length, 1, '退避窗口内不得重试')
    await engine.dispose()
  })

  it('会话新变更重置退避：revision 变化立即重试并成功', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_b2')
    await persistence.addSession(h, [await headerFrame(h)])

    const { engine } = await makeEngine(tmp, server, persistence)
    server.failUploads = true
    await engine.start()
    await engine.flush()

    // 故障恢复 + 会话产生新内容（revision 变化）：退避应被重置，立即上传成功
    server.failUploads = false
    await persistence.append(h, [await frameOf(['{"type":"user/message","seq":0,"time":100,"data":{}}'])])
    await engine.scan()
    await engine.flush()
    const remote = server.objects.get(logKey(DEVICE, 's_b2'))
    assert.ok(remote, '新变更应绕过退避立即上传')
    const localFile = await fsp.readFile(persistence.files.get('s_b2')!)
    assert.deepEqual(decryptLog(KEY, 's_b2', remote!), localFile)
    await engine.dispose()
  })

  it('syncAllNow 重置全部退避：用户显式触发不被退避窗口挡住', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_b3')
    await persistence.addSession(h, [await headerFrame(h)])

    const { engine } = await makeEngine(tmp, server, persistence)
    server.failUploads = true
    await engine.start()
    await engine.flush()
    assert.equal(server.objects.size, 0)

    // 退避 1s 未到，但用户点了「立即全部同步」：应立即重试并成功
    server.failUploads = false
    const result = await engine.syncAllNow()
    assert.deepEqual(result, { ok: 1, failed: 0, firstError: undefined })
    assert.ok(server.objects.get(logKey(DEVICE, 's_b3')), 'syncAllNow 应绕过退避上传')
    await engine.dispose()
  })

  // ---- requestScan（session/flush 钩子的引擎入口） ----

  it('requestScan：合并窗口内多次触发，最终完成一次变更发现与上传', async () => {
    const tmp = await tmpdir()
    const server = new FakeServer()
    const persistence = new FakePersistence(tmp)
    const h = header('s_b4')
    await persistence.addSession(h, [await headerFrame(h)])

    const { engine } = await makeEngine(tmp, server, persistence)
    engine.requestScan()
    engine.requestScan()
    engine.requestScan()

    // 防抖 500ms + 会话调度 5ms：轮询等待上传落地
    const deadline = Date.now() + 5000
    while (!server.objects.has(logKey(DEVICE, 's_b4')) && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.ok(server.objects.has(logKey(DEVICE, 's_b4')), 'requestScan 应驱动一次完整上传')
    await engine.dispose()
  })
})
