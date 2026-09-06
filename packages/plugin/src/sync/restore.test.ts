/**
 * 恢复链路单测（docs/02 §11）：路径解析四路、header.cwd 改写的字节边界断言、
 * 映射学习/删除、目录拉取标注、落位与已存在拒绝、workspace 挂载、恢复后抑制立刻回传。
 */
import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { LogEncryptor, decryptLog, deriveKey, encryptMeta, generateSalt, type SessionMeta } from '../crypto/envelope.js'
import type { SessionHeaderLike, SessionSnapshotLike } from '../dsh-types.js'
import type { RemoteObject } from './http-client.js'
import {
  decodeMappingDelete,
  decodeRestoreRequest,
  deleteMapping,
  encodeCatalog,
  encodeMappings,
  encodeRestoreResult,
  encodeStartupNotice,
  fetchCatalog,
  learnMapping,
  markRestoredSynced,
  normalizeTargetCwd,
  parseHeaderFromLog,
  resolveTargetCwd,
  restoreSessions,
  rewriteCwd,
  tailSegment,
  type CatalogDeps,
  type RestoreDeps,
} from './restore.js'
import { scanZstdFrames, zstdCompressAsync, zstdDecompressAsync, ZSTD_CHECKSUM_OPTIONS } from './frames.js'
import type { SessionSyncState, StateStore } from './state.js'

// ---- 测试替身 ----

class FakeStateStore implements StateStore {
  sessions = new Map<string, SessionSyncState>()
  global = { pathMappings: [] as { from: string; to: string }[] }
  getSession(id: string): SessionSyncState | undefined {
    return this.sessions.get(id)
  }
  async putSession(id: string, state: SessionSyncState): Promise<void> {
    this.sessions.set(id, state)
  }
  entries(): IterableIterator<[string, SessionSyncState]> {
    return this.sessions.entries()
  }
  getGlobal(): { pathMappings: { from: string; to: string }[] } {
    return this.global
  }
  async setGlobal(patch: Partial<{ pathMappings: { from: string; to: string }[] }>): Promise<void> {
    Object.assign(this.global, patch)
  }
  async close(): Promise<void> {}
}

/** 内存哑存储客户端：key → bytes，list 支持前缀过滤。 */
class FakeClient {
  objects = new Map<string, Buffer>()
  async list(prefix?: string): Promise<RemoteObject[]> {
    return [...this.objects.keys()]
      .filter((key) => prefix === undefined || key.startsWith(prefix))
      .sort()
      .map((key) => ({ key, size: this.objects.get(key)!.length, revision: '1', lastModified: '' }))
  }
  async download(key: string): Promise<Buffer> {
    const bytes = this.objects.get(key)
    if (!bytes) throw new Error(`404 ${key}`)
    return bytes
  }
}

/** 落位路径复刻 dsh 布局语义（root/<cwd 尾段>/<id>/session.jsonl.zstd），仅供断言 locate 被调用。 */
class FakePersistence {
  constructor(
    private root: string,
    private headers: SessionHeaderLike[] = [],
  ) {}
  located: SessionHeaderLike[] = []
  locate(meta: SessionHeaderLike): { kind: string; path: string } {
    this.located.push(meta)
    const project = meta.cwd === undefined ? '_no-cwd' : `--${tailSegment(meta.cwd)}--`
    return { kind: 'jsonl', path: path.join(this.root, project, meta.id, 'session.jsonl.zstd') }
  }
  async list(): Promise<SessionHeaderLike[]> {
    return this.headers
  }
  async listSnapshots(): Promise<SessionSnapshotLike[]> {
    return this.headers.map((header) => ({ header, revision: `rev-${header.id}` }))
  }
}

// ---- 造数：合成 dsh 形态的 zstd 会话日志 ----

const HEADER: SessionHeaderLike = {
  version: 0,
  id: 'session-1',
  createdAt: 1725000000000,
  cwd: '/home/alice/p/proj',
  delegationDepth: 0,
}

async function makeLog(header: SessionHeaderLike, events: string[]): Promise<Buffer> {
  const headerLine = JSON.stringify({ type: 'session', ...header })
  const firstFrame = await zstdCompressAsync(Buffer.from([headerLine, ...events.slice(0, 1)].join('\n'), 'utf8'), ZSTD_CHECKSUM_OPTIONS)
  const frames = [firstFrame]
  for (const line of events.slice(1)) {
    frames.push(await zstdCompressAsync(Buffer.from(line, 'utf8'), ZSTD_CHECKSUM_OPTIONS))
  }
  return Buffer.concat(frames)
}

const EVENTS = [
  JSON.stringify({ type: 'session/title', time: 1725000001000, data: { title: '样例会话' } }),
  JSON.stringify({ type: 'message', time: 1725000002000, data: { role: 'user', text: 'hi' } }),
]

function makeMeta(sessionId: string, over: Partial<SessionMeta> = {}): SessionMeta {
  return {
    sessionId,
    title: '样例会话',
    createdAt: 1725000000000,
    updatedAt: 1725000002000,
    eventCount: 2,
    formatVersion: 0,
    cwd: '/home/alice/p/proj',
    device: 'device-a',
    ...over,
  }
}

const salt = generateSalt()
const key = deriveKey('test-passphrase', salt)

function catalogDeps(client: FakeClient, state: FakeStateStore, persistence: FakePersistence, workspacePaths: string[] = []): CatalogDeps {
  return { client: client as never, key, persistence, state, workspacePaths }
}

// ---- 纯函数：路径解析 ----

test('normalizeTargetCwd：~ 与相对路径落到本机 home，绝对路径原样', () => {
  const home = os.homedir()
  assert.equal(normalizeTargetCwd('~/my-app'), path.join(home, 'my-app'))
  assert.equal(normalizeTargetCwd('~'), home)
  assert.equal(normalizeTargetCwd('my-app'), path.join(home, 'my-app'))
  assert.equal(normalizeTargetCwd('/Users/alice/my-app'), '/Users/alice/my-app')
  assert.equal(normalizeTargetCwd(''), '')
})

test('tailSegment 取路径最后一个非空段', () => {
  assert.equal(tailSegment('/home/alice/p/proj'), 'proj')
  assert.equal(tailSegment('/home/alice/p/proj/'), 'proj')
  assert.equal(tailSegment('/'), '')
  assert.equal(tailSegment(''), '')
})

test('resolveTargetCwd：已学习映射精确命中', () => {
  const result = resolveTargetCwd('/home/alice/p/proj', [{ from: '/home/alice/p/proj', to: '/Users/bob/code/proj' }], [])
  assert.deepEqual(result, { kind: 'mapping', cwd: '/Users/bob/code/proj' })
})

test('resolveTargetCwd：已学习映射前缀命中，子路径平移', () => {
  const result = resolveTargetCwd('/home/alice/p/proj/sub', [{ from: '/home/alice/p', to: '/Users/bob/code' }], [])
  assert.deepEqual(result, { kind: 'mapping', cwd: '/Users/bob/code/proj/sub' })
})

test('resolveTargetCwd：前缀命中按数组顺序取首个', () => {
  const result = resolveTargetCwd('/a/b/c', [
    { from: '/a/b', to: '/x' },
    { from: '/a', to: '/y' },
  ], [])
  assert.deepEqual(result, { kind: 'mapping', cwd: '/x/c' })
})

test('resolveTargetCwd：映射未命中时按尾段名在工作区找建议', () => {
  const result = resolveTargetCwd('/home/alice/p/proj', [], ['/Users/bob/code/other', '/Users/bob/code/proj'])
  assert.deepEqual(result, { kind: 'suggested', cwd: '/Users/bob/code/proj' })
})

test('resolveTargetCwd：皆无 → none；空来源 cwd → none', () => {
  assert.deepEqual(resolveTargetCwd('/no/match/here', [], ['/Users/bob/code/other']), { kind: 'none', cwd: null })
  assert.deepEqual(resolveTargetCwd('', [{ from: '/a', to: '/b' }], ['/b']), { kind: 'none', cwd: null })
})

// ---- header.cwd 改写的字节边界 ----

test('rewriteCwd：仅 header.cwd 变化，事件正文逐字节一致', async () => {
  const original = await makeLog(HEADER, EVENTS)
  const rewritten = await rewriteCwd(original, '/Users/bob/code/proj')

  // 帧数一致；首帧之外的帧字节原样
  const scanOriginal = scanZstdFrames(original)
  const scanRewritten = scanZstdFrames(rewritten)
  assert.equal(scanOriginal.frames.length, scanRewritten.frames.length)
  const tailOriginal = original.subarray(scanOriginal.frames[0].end)
  const tailRewritten = rewritten.subarray(scanRewritten.frames[0].end)
  assert.ok(tailOriginal.equals(tailRewritten), '首帧之后的字节必须逐字节一致')

  // 首帧解压后：除首行 cwd 外逐行一致
  const firstOriginal = (await zstdDecompressAsync(original.subarray(scanOriginal.frames[0].start, scanOriginal.frames[0].end))).toString('utf8')
  const firstRewritten = (await zstdDecompressAsync(rewritten.subarray(0, scanRewritten.frames[0].end))).toString('utf8')
  const originalLines = firstOriginal.split('\n')
  const rewrittenLines = firstRewritten.split('\n')
  assert.equal(originalLines.length, rewrittenLines.length)
  const originalHeader = JSON.parse(originalLines[0]) as Record<string, unknown>
  const rewrittenHeader = JSON.parse(rewrittenLines[0]) as Record<string, unknown>
  assert.equal(rewrittenHeader.cwd, '/Users/bob/code/proj')
  delete originalHeader.cwd
  delete rewrittenHeader.cwd
  assert.deepEqual(rewrittenHeader, originalHeader, 'header 除 cwd 字段外不得变化')
  for (let i = 1; i < originalLines.length; i += 1) {
    assert.equal(rewrittenLines[i], originalLines[i], `首帧第 ${i} 行必须逐字节一致`)
  }
})

test('parseHeaderFromLog 还原 header 字段', async () => {
  const log = await makeLog(HEADER, EVENTS)
  const header = await parseHeaderFromLog(log)
  assert.equal(header.id, 'session-1')
  assert.equal(header.cwd, '/home/alice/p/proj')
  assert.equal(header.version, 0)
})

test('rewriteCwd：来源无 cwd 时插入该字段', async () => {
  const { cwd, ...noCwdHeader } = HEADER
  void cwd
  const original = await makeLog(noCwdHeader, EVENTS)
  const rewritten = await rewriteCwd(original, '/Users/bob/code/proj')
  const header = await parseHeaderFromLog(rewritten)
  assert.equal(header.cwd, '/Users/bob/code/proj')
})

// ---- 映射学习 ----

test('learnMapping：新条目置顶，同 from 旧条目被替换', async () => {
  const state = new FakeStateStore()
  await learnMapping(state, '/a', '/x')
  await learnMapping(state, '/b', '/y')
  assert.deepEqual(state.global.pathMappings, [{ from: '/b', to: '/y' }, { from: '/a', to: '/x' }])
  await learnMapping(state, '/a', '/z')
  assert.deepEqual(state.global.pathMappings, [{ from: '/a', to: '/z' }, { from: '/b', to: '/y' }])
})

test('deleteMapping：按 from 删除', async () => {
  const state = new FakeStateStore()
  await learnMapping(state, '/a', '/x')
  await learnMapping(state, '/b', '/y')
  await deleteMapping(state, '/a')
  assert.deepEqual(state.global.pathMappings, [{ from: '/b', to: '/y' }])
})

// ---- 目录拉取 ----

test('fetchCatalog：解密全设备 meta 并标注 existsLocal / 版本 / 路径解析', async () => {
  const client = new FakeClient()
  client.objects.set('sessions/device-a/s-1.meta.enc', encryptMeta(key, salt, 's-1', makeMeta('s-1', { cwd: '/home/alice/p/proj' })))
  client.objects.set('sessions/device-a/s-2.meta.enc', encryptMeta(key, salt, 's-2', makeMeta('s-2', { updatedAt: 1725000009000 })))
  client.objects.set('sessions/device-b/s-3.meta.enc', encryptMeta(key, salt, 's-3', makeMeta('s-3', { device: 'device-b', formatVersion: 9, updatedAt: 1725000005000 })))
  client.objects.set('keys/device-a/kdf.json', Buffer.from('{}')) // 非 meta 对象不参与

  const state = new FakeStateStore()
  const persistence = new FakePersistence('/unused', [{ ...HEADER, id: 's-1' }])
  const entries = await fetchCatalog(catalogDeps(client, state, persistence, ['/Users/bob/code/proj']))

  assert.equal(entries.length, 3)
  // 倒序：s-2 > s-3 > s-1
  assert.deepEqual(entries.map((entry) => entry.sessionId), ['s-2', 's-3', 's-1'])
  const s1 = entries.find((entry) => entry.sessionId === 's-1')!
  assert.equal(s1.existsLocal, true)
  assert.equal(s1.resolvedCwd, null, '本地已存在的行不做路径解析')
  const s2 = entries.find((entry) => entry.sessionId === 's-2')!
  assert.equal(s2.resolvedCwd, '/Users/bob/code/proj')
  assert.equal(s2.resolution, 'suggested')
  const s3 = entries.find((entry) => entry.sessionId === 's-3')!
  assert.equal(s3.versionIncompatible, true, 'formatVersion 高于本机即不兼容')
})

test('fetchCatalog：兼容基准随本机会话 header 的 version 自适应（上游 bump 后不再误判）', async () => {
  const client = new FakeClient()
  // 云端 meta 与本机 header 同为 v3：以本机运行时版本为基准应判兼容
  client.objects.set('sessions/device-a/s-9.meta.enc', encryptMeta(key, salt, 's-9', makeMeta('s-9', { formatVersion: 3 })))
  client.objects.set('sessions/device-a/s-8.meta.enc', encryptMeta(key, salt, 's-8', makeMeta('s-8', { formatVersion: 4 })))
  const persistence = new FakePersistence('/unused', [{ ...HEADER, id: 'local-1', version: 3 }])
  const entries = await fetchCatalog(catalogDeps(client, new FakeStateStore(), persistence))
  const s9 = entries.find((entry) => entry.sessionId === 's-9')!
  assert.equal(s9.versionIncompatible, false, '等于本机版本应兼容')
  const s8 = entries.find((entry) => entry.sessionId === 's-8')!
  assert.equal(s8.versionIncompatible, true, '高于本机版本仍应拒绝')
})

test('fetchCatalog：本地无任何会话时以 LOCAL_FORMAT_VERSION 常量兜底', async () => {
  const client = new FakeClient()
  client.objects.set('sessions/device-a/s-1.meta.enc', encryptMeta(key, salt, 's-1', makeMeta('s-1', { formatVersion: 2 })))
  client.objects.set('sessions/device-a/s-2.meta.enc', encryptMeta(key, salt, 's-2', makeMeta('s-2', { formatVersion: 3 })))
  const entries = await fetchCatalog(catalogDeps(client, new FakeStateStore(), new FakePersistence('/unused')))
  const s1 = entries.find((entry) => entry.sessionId === 's-1')!
  assert.equal(s1.versionIncompatible, false, 'v2 等于当前 dsh SESSION_FORMAT_VERSION，应兼容')
  const s2 = entries.find((entry) => entry.sessionId === 's-2')!
  assert.equal(s2.versionIncompatible, true)
})

test('fetchCatalog：口令不匹配（meta 解不开）的行跳过并告警，不打断目录', async () => {
  const client = new FakeClient()
  const wrongKey = deriveKey('wrong', salt)
  client.objects.set('sessions/device-a/s-1.meta.enc', encryptMeta(wrongKey, salt, 's-1', makeMeta('s-1')))
  client.objects.set('sessions/device-a/s-2.meta.enc', encryptMeta(key, salt, 's-2', makeMeta('s-2')))
  const warnings: string[] = []
  const deps = { ...catalogDeps(client, new FakeStateStore(), new FakePersistence('/unused')), onWarn: (message: string) => warnings.push(message) }
  const entries = await fetchCatalog(deps)
  assert.deepEqual(entries.map((entry) => entry.sessionId), ['s-2'])
  assert.equal(warnings.length, 1)
})

// ---- 恢复执行 ----

async function seedCloudSession(client: FakeClient, device: string, sessionId: string, log: Buffer): Promise<void> {
  const encryptor = new LogEncryptor(key, salt, sessionId)
  client.objects.set(`sessions/${device}/${sessionId}.log.enc`, Buffer.concat([encryptor.objectHeader(), encryptor.append(log)]))
}

test('restoreSessions：无映射时原样落位到 locate() 路径', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  try {
    const client = new FakeClient()
    const log = await makeLog({ ...HEADER, id: 's-1' }, EVENTS)
    await seedCloudSession(client, 'device-a', 's-1', log)
    const state = new FakeStateStore()
    const persistence = new FakePersistence(root)
    const deps: RestoreDeps = { client: client as never, key, persistence, state }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: null }])
    assert.deepEqual({ ok: result.ok, failed: result.failed }, { ok: 1, failed: 0 })

    // 落位路径来自 locate()，header 原样（cwd 未改写）
    assert.equal(persistence.located.length, 1)
    assert.equal(persistence.located[0].cwd, '/home/alice/p/proj')
    const written = await fsp.readFile(persistence.locate({ ...HEADER, id: 's-1' }).path)
    assert.ok(written.equals(log), '无映射恢复的字节必须与云端明文一致')
    assert.deepEqual(state.global.pathMappings, [], '未改选目录时不学习映射')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('restoreSessions：目标为 ~ 时展开到本机 home 落位（跨机相对路径心智）', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  try {
    const client = new FakeClient()
    const log = await makeLog({ ...HEADER, id: 's-1', cwd: '/Users/alice/my-app' }, EVENTS)
    await seedCloudSession(client, 'device-a', 's-1', log)
    const state = new FakeStateStore()
    const persistence = new FakePersistence(root)
    const deps: RestoreDeps = { client: client as never, key, persistence, state }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: '~' }])
    assert.deepEqual({ ok: result.ok, failed: result.failed }, { ok: 1, failed: 0 })
    assert.equal(persistence.located[0].cwd, os.homedir(), '~ 展开后改写 header.cwd')
    assert.deepEqual(state.global.pathMappings, [{ from: '/Users/alice/my-app', to: os.homedir() }], '学习来源→本机 home 的映射')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('restoreSessions：映射恢复改写 header.cwd、学习映射、其余字节不动', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-target-'))
  try {
    const client = new FakeClient()
    const log = await makeLog({ ...HEADER, id: 's-1' }, EVENTS)
    await seedCloudSession(client, 'device-a', 's-1', log)
    const state = new FakeStateStore()
    const persistence = new FakePersistence(root)
    const deps: RestoreDeps = { client: client as never, key, persistence, state }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: target }])
    assert.deepEqual({ ok: result.ok, failed: result.failed }, { ok: 1, failed: 0 })
    assert.deepEqual(state.global.pathMappings, [{ from: '/home/alice/p/proj', to: target }])
    assert.equal(persistence.located[0].cwd, target, 'locate 必须拿到归位后的 cwd')

    const writtenPath = persistence.locate({ ...HEADER, id: 's-1', cwd: target }).path
    const written = await fsp.readFile(writtenPath)
    const scanOriginal = scanZstdFrames(log)
    const scanWritten = scanZstdFrames(written)
    assert.ok(log.subarray(scanOriginal.frames[0].end).equals(written.subarray(scanWritten.frames[0].end)))
    const writtenHeader = await parseHeaderFromLog(written)
    assert.equal(writtenHeader.cwd, target)
    // 写出的文件仍能被链式信封语义还原（此处直接验证明文形态合法）
    assert.equal(scanWritten.frames.length, scanOriginal.frames.length)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(target, { recursive: true, force: true })
  }
})

// ---- workspace 挂载（恢复会话在 web 侧边栏的可见性，docs/02 §4.3） ----

test('restoreSessions：落位成功后按有效 cwd 挂载 workspace', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-target-'))
  try {
    const client = new FakeClient()
    await seedCloudSession(client, 'device-a', 's-1', await makeLog({ ...HEADER, id: 's-1' }, EVENTS))
    const attached: { sessionId: string; cwd: string }[] = []
    const deps: RestoreDeps = {
      client: client as never,
      key,
      persistence: new FakePersistence(root),
      state: new FakeStateStore(),
      attachWorkspace: async (sessionId, cwd) => {
        attached.push({ sessionId, cwd })
      },
    }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: target }])
    assert.equal(result.ok, 1)
    assert.deepEqual(attached, [{ sessionId: 's-1', cwd: target }], '映射恢复按归位后的 cwd 挂载')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(target, { recursive: true, force: true })
  }
})

test('restoreSessions：原样落位且来源 cwd 本机存在时，同样挂载（同机恢复）', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  const localCwd = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-cwd-'))
  try {
    const client = new FakeClient()
    await seedCloudSession(client, 'device-a', 's-1', await makeLog({ ...HEADER, id: 's-1', cwd: localCwd }, EVENTS))
    const attached: { sessionId: string; cwd: string }[] = []
    const deps: RestoreDeps = {
      client: client as never,
      key,
      persistence: new FakePersistence(root),
      state: new FakeStateStore(),
      attachWorkspace: async (sessionId, cwd) => {
        attached.push({ sessionId, cwd })
      },
    }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: null }])
    assert.equal(result.ok, 1)
    assert.deepEqual(attached, [{ sessionId: 's-1', cwd: localCwd }])
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(localCwd, { recursive: true, force: true })
  }
})

test('restoreSessions：原样落位到本机不存在的来源 cwd 不挂载（未分组语义）', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  try {
    const client = new FakeClient()
    await seedCloudSession(client, 'device-a', 's-1', await makeLog({ ...HEADER, id: 's-1' }, EVENTS))
    let attachCalls = 0
    const deps: RestoreDeps = {
      client: client as never,
      key,
      persistence: new FakePersistence(root),
      state: new FakeStateStore(),
      attachWorkspace: async () => {
        attachCalls += 1
      },
    }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: null }])
    assert.equal(result.ok, 1)
    assert.equal(attachCalls, 0, '来源路径本机不存在时不尝试挂载')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('restoreSessions：显式目标目录不存在 → 写盘前失败，不学习映射不挂载', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  try {
    const client = new FakeClient()
    await seedCloudSession(client, 'device-a', 's-1', await makeLog({ ...HEADER, id: 's-1' }, EVENTS))
    const state = new FakeStateStore()
    const persistence = new FakePersistence(root)
    let attachCalls = 0
    const deps: RestoreDeps = {
      client: client as never,
      key,
      persistence,
      state,
      attachWorkspace: async () => {
        attachCalls += 1
      },
    }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: path.join(root, 'no-such-dir') }])
    assert.deepEqual({ ok: result.ok, failed: result.failed }, { ok: 0, failed: 1 })
    assert.match(result.firstError, /目标目录不存在/)
    assert.deepEqual(state.global.pathMappings, [], '失败前不得学习映射')
    assert.equal(attachCalls, 0)
    // 未写盘：占位目录里没有会话文件
    assert.equal((await fsp.readdir(root)).length, 0)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('restoreSessions：挂载失败仅告警，恢复仍计成功', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  const target = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-target-'))
  try {
    const client = new FakeClient()
    await seedCloudSession(client, 'device-a', 's-1', await makeLog({ ...HEADER, id: 's-1' }, EVENTS))
    const warnings: string[] = []
    const deps: RestoreDeps = {
      client: client as never,
      key,
      persistence: new FakePersistence(root),
      state: new FakeStateStore(),
      attachWorkspace: async () => {
        throw new Error('registry boom')
      },
      onWarn: (message) => warnings.push(message),
    }

    const result = await restoreSessions(deps, [{ sessionId: 's-1', device: 'device-a', targetCwd: target }])
    assert.deepEqual({ ok: result.ok, failed: result.failed }, { ok: 1, failed: 0 }, '挂载失败不回滚恢复')
    assert.equal(warnings.length, 1)
    assert.match(warnings[0], /挂载失败/)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
    await fsp.rm(target, { recursive: true, force: true })
  }
})

test('restoreSessions：本地已存在拒绝覆盖，单条失败不中断其余', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  try {
    const client = new FakeClient()
    const log1 = await makeLog({ ...HEADER, id: 's-1' }, EVENTS)
    const log2 = await makeLog({ ...HEADER, id: 's-2' }, EVENTS)
    await seedCloudSession(client, 'device-a', 's-1', log1)
    await seedCloudSession(client, 'device-a', 's-2', log2)
    const state = new FakeStateStore()
    const persistence = new FakePersistence(root)
    // 预先占住 s-1 的落位
    const occupied = persistence.locate({ ...HEADER, id: 's-1' }).path
    await fsp.mkdir(path.dirname(occupied), { recursive: true })
    await fsp.writeFile(occupied, 'local copy')

    const result = await restoreSessions({ client: client as never, key, persistence, state }, [
      { sessionId: 's-1', device: 'device-a', targetCwd: null },
      { sessionId: 's-2', device: 'device-a', targetCwd: null },
    ])
    assert.deepEqual({ ok: result.ok, failed: result.failed }, { ok: 1, failed: 1 })
    assert.match(result.firstError, /s-1.*already exists/)
    assert.equal(await fsp.readFile(occupied, 'utf8'), 'local copy', '既有文件不得被覆盖')
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

test('restoreSessions：密文链校验失败（口令不符）计失败', async () => {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'dsh-restore-'))
  try {
    const client = new FakeClient()
    const wrongKey = deriveKey('wrong', salt)
    const encryptor = new LogEncryptor(wrongKey, salt, 's-1')
    client.objects.set('sessions/device-a/s-1.log.enc', Buffer.concat([encryptor.objectHeader(), encryptor.append(await makeLog(HEADER, EVENTS))]))
    const result = await restoreSessions(
      { client: client as never, key, persistence: new FakePersistence(root), state: new FakeStateStore() },
      [{ sessionId: 's-1', device: 'device-a', targetCwd: null }],
    )
    assert.equal(result.failed, 1)
  } finally {
    await fsp.rm(root, { recursive: true, force: true })
  }
})

// ---- 恢复后抑制回传 ----

test('markRestoredSynced：以当前 revision 记入 state，引擎不再视为变更', async () => {
  const state = new FakeStateStore()
  const persistence = new FakePersistence('/unused', [{ ...HEADER, id: 's-1' }, { ...HEADER, id: 'other' }])
  await markRestoredSynced({ persistence, state }, ['s-1'])
  const stored = state.getSession('s-1')!
  assert.equal(stored.localRevision, 'rev-s-1')
  assert.equal(stored.uploadedBytes, 0)
  assert.equal(stored.lastSegmentIndex, -1)
  assert.equal(stored.status, 'ok')
  assert.ok(stored.restoredAt !== undefined, '恢复抑制标记：自愈判定不把它当污染条目')
  assert.equal(state.getSession('other'), undefined, '不在恢复清单里的会话不动')
})

// ---- 通道 JSON 载荷 ----

test('通道载荷编解码：catalog / result / mappings / notice / 请求解析', () => {
  const catalog = { at: 1, selfDevice: 'mac', sessions: [], error: '' }
  assert.deepEqual(JSON.parse(encodeCatalog(catalog)), catalog)
  const result = { at: 2, ok: 1, failed: 0, firstError: '' }
  assert.deepEqual(JSON.parse(encodeRestoreResult(result)), result)
  assert.deepEqual(JSON.parse(encodeMappings([{ from: '/a', to: '/b' }])), [{ from: '/a', to: '/b' }])
  assert.deepEqual(JSON.parse(encodeStartupNotice({ at: 3, count: 2 })), { at: 3, count: 2 })

  assert.deepEqual(decodeRestoreRequest('{"at":4,"items":[{"sessionId":"s","device":"d","targetCwd":null}]}'), {
    at: 4,
    items: [{ sessionId: 's', device: 'd', targetCwd: null }],
  })
  assert.equal(decodeRestoreRequest('not json'), undefined)
  assert.equal(decodeRestoreRequest('{"items":[]}'), undefined)
  assert.deepEqual(decodeMappingDelete('{"at":5,"from":"/a"}'), { at: 5, from: '/a' })
  assert.equal(decodeMappingDelete('{"at":5}'), undefined)
})

// decryptLog 反向校验：恢复出的明文与上行加密前一致（链式信封往返）
test('恢复链路往返：LogEncryptor 上行 → decryptLog 下行还原同一字节', async () => {
  const log = await makeLog(HEADER, EVENTS)
  const encryptor = new LogEncryptor(key, salt, 's-9')
  const first = encryptor.append(log.subarray(0, 100))
  const second = encryptor.append(log.subarray(100))
  const object = Buffer.concat([encryptor.objectHeader(), first, second])
  // 分段切在 100 字节处，第一段末尾不是帧边界——恢复端不扫帧直接拼接解密
  const restored = decryptLog(key, 's-9', object)
  assert.ok(restored.equals(log))
})
