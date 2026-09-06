import assert from 'node:assert/strict'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { after, describe, it } from 'node:test'
import type { SessionHeaderLike, SessionSnapshotLike } from '../dsh-types.ts'
import { createPersistencePort, encodeSegmentOf, projectKeyOf, sessionDirOf } from './persistence-port.ts'

const HEADER: SessionHeaderLike = { version: 0, id: 'session-159e9f69-861c-4b49-8b22-ead284c67b7c', createdAt: 1, delegationDepth: 0 }
const SNAPSHOTS: SessionSnapshotLike[] = [{ header: HEADER, revision: 'rev-1' }]

describe('projectKeyOf / encodeSegmentOf（复刻 dsh jsonl 布局编码）', () => {
  it('分隔符折叠为 -，整体包 --…--', () => {
    assert.equal(projectKeyOf('/Users/alice/proj'), '--Users-alice-proj--')
  })

  it('非 ASCII 码位转 ~XXXX 大写十六进制', () => {
    // 与真实磁盘目录 --Users-alice-~6C90~6625~4E1A~59D4~4F1A-- 对齐
    const observed = String.fromCharCode(0x6C90, 0x6625, 0x4E1A, 0x59D4, 0x4F1A)
    assert.equal(projectKeyOf(`/Users/alice/${observed}`), '--Users-alice-~6C90~6625~4E1A~59D4~4F1A--')
    assert.equal(projectKeyOf('/Users/alice/现代服饰'), '--Users-alice-~73B0~4EE3~670D~9970--')
  })

  it('连续分隔符折叠、前导 - 剥离、空 slug 回退 root', () => {
    assert.equal(projectKeyOf('///a//b'), '--a-b--')
    assert.equal(projectKeyOf(':::'), '--root--')
  })

  it('会话 id 安全字符直通，特殊字符转义', () => {
    assert.equal(encodeSegmentOf('session-abc123'), 'session-abc123')
    assert.equal(encodeSegmentOf('a b'), 'a~0020b')
    assert.equal(encodeSegmentOf('..'), '~002E~002E')
  })

  it('无 cwd 落 _no-cwd', () => {
    assert.equal(sessionDirOf('/root', undefined, 's-1'), path.join('/root', '_no-cwd', 's-1'))
  })
})

describe('createPersistencePort', () => {
  const tmpDirs: string[] = []
  async function tmpRoot(): Promise<string> {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'pport-'))
    tmpDirs.push(dir)
    return dir
  }
  after(async () => {
    await Promise.all(tmpDirs.map((dir) => fsp.rm(dir, { recursive: true, force: true })))
  })

  it('v0 宿主：三方法原样透传', async () => {
    let listedSnapshots = 0
    let listed = 0
    let located = 0
    const port = createPersistencePort({
      listSnapshots: async () => { listedSnapshots += 1; return SNAPSHOTS },
      list: async () => { listed += 1; return [HEADER] },
      locate: (meta) => { located += 1; return { kind: 'jsonl', path: `/x/${meta.id}` } },
    }, '/unused')
    assert.deepEqual(await port.listSnapshots(), SNAPSHOTS)
    assert.deepEqual(await port.list(), [HEADER])
    assert.deepEqual(port.locate(HEADER), { kind: 'jsonl', path: `/x/${HEADER.id}` })
    assert.equal(listedSnapshots + listed + located, 3)
  })

  it('v0 宿主无 locate（SQLite 形态）：locate 返回 undefined', () => {
    const port = createPersistencePort({ listSnapshots: async () => SNAPSHOTS, list: async () => [HEADER] }, '/unused')
    assert.equal(port.locate(HEADER), undefined)
  })

  it('v1 宿主：list() 即快照枚举，port.list() 归一为 header 数组', async () => {
    const port = createPersistencePort({ list: async () => SNAPSHOTS }, '/unused')
    assert.deepEqual(await port.listSnapshots(), SNAPSHOTS)
    assert.deepEqual(await port.list(), [HEADER])
  })

  it('v1 宿主：zstd artifact 存在时 locate 指向它', async () => {
    const root = await tmpRoot()
    const dir = sessionDirOf(root, '/Users/alice/proj', HEADER.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'session.jsonl.zstd'), 'x')
    const port = createPersistencePort({ list: async () => SNAPSHOTS }, root)
    assert.deepEqual(port.locate({ ...HEADER, cwd: '/Users/alice/proj' }), { kind: 'jsonl', path: path.join(dir, 'session.jsonl.zstd') })
  })

  it('v1 宿主：仅明文存在时指明文（引擎将标记 skipped-plain）', async () => {
    const root = await tmpRoot()
    const dir = sessionDirOf(root, '/Users/alice/proj', HEADER.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'session.jsonl'), 'x')
    const port = createPersistencePort({ list: async () => SNAPSHOTS }, root)
    assert.deepEqual(port.locate({ ...HEADER, cwd: '/Users/alice/proj' }), { kind: 'jsonl', path: path.join(dir, 'session.jsonl') })
  })

  it('v1 宿主：无 artifact 时按 zstd 路径纯推导（restore 写入依赖）', async () => {
    const root = await tmpRoot()
    const port = createPersistencePort({ list: async () => SNAPSHOTS }, root)
    const expected = path.join(sessionDirOf(root, '/Users/alice/proj', HEADER.id), 'session.jsonl.zstd')
    assert.deepEqual(port.locate({ ...HEADER, cwd: '/Users/alice/proj' }), { kind: 'jsonl', path: expected })
  })

  it('v1 宿主：v2 代会话优先指 session.v2.jsonl.zstd（0.1.3-alpha.1 实际布局）', async () => {
    const root = await tmpRoot()
    const header = { ...HEADER, version: 2 }
    const dir = sessionDirOf(root, '/Users/alice/proj', header.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'session.v2.jsonl.zstd'), 'x')
    const port = createPersistencePort({ list: async () => SNAPSHOTS }, root)
    assert.deepEqual(port.locate({ ...header, cwd: '/Users/alice/proj' }), { kind: 'jsonl', path: path.join(dir, 'session.v2.jsonl.zstd') })
  })

  it('v1 宿主：v2 代目录里只剩 v0 旧形态文件时回退命中（代升级残留）', async () => {
    const root = await tmpRoot()
    const header = { ...HEADER, version: 2 }
    const dir = sessionDirOf(root, '/Users/alice/proj', header.id)
    await fsp.mkdir(dir, { recursive: true })
    await fsp.writeFile(path.join(dir, 'session.jsonl.zstd'), 'x')
    const port = createPersistencePort({ list: async () => SNAPSHOTS }, root)
    assert.deepEqual(port.locate({ ...header, cwd: '/Users/alice/proj' }), { kind: 'jsonl', path: path.join(dir, 'session.jsonl.zstd') })
  })

  it('v1 宿主：v2 代无 artifact 时推导 session.v2.jsonl.zstd（不复退回 v0 形态）', async () => {
    const root = await tmpRoot()
    const header = { ...HEADER, version: 2 }
    const port = createPersistencePort({ list: async () => SNAPSHOTS }, root)
    const expected = path.join(sessionDirOf(root, '/Users/alice/proj', header.id), 'session.v2.jsonl.zstd')
    assert.deepEqual(port.locate({ ...header, cwd: '/Users/alice/proj' }), { kind: 'jsonl', path: expected })
  })
})
