/**
 * 多用户隔离测试：以子进程起真实 server（DSH_SYNC_TOKENS），
 * 验证 ① 用户间 key 空间与列表完全隔离 ② 落盘按用户名分目录
 * ③ 单用户模式（DSH_SYNC_TOKEN）行为不变（数据在 DATA_DIR 根）。
 */
import { strict as assert } from 'node:assert'
import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const SERVER = path.resolve(import.meta.dirname, '../src/index.ts')

interface Handle {
  base: string
  stop(): Promise<void>
}

/** 起一个 server 子进程，等待 healthz 就绪。 */
async function startServer(env: Record<string, string>): Promise<Handle> {
  const port = 20000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, ['--import', 'tsx', SERVER], {
    env: { ...process.env, PORT: String(port), ...env },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (c) => { output += c })
  child.stderr.on('data', (c) => { output += c })
  const base = `http://127.0.0.1:${port}`
  const deadline = Date.now() + 15_000
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${base}/v1/healthz`)
      if (res.ok) break
    } catch { /* 未就绪，继续等 */ }
    if (child.exitCode !== null) throw new Error(`server exited early:\n${output}`)
    await new Promise((r) => setTimeout(r, 100))
  }
  return {
    base,
    stop: () => new Promise<void>((resolve) => {
      child.on('exit', () => resolve())
      child.kill()
    }),
  }
}

function auth(token: string): { Authorization: string } {
  return { Authorization: `Bearer ${token}` }
}

test('多用户：key 空间与列表按 token 隔离，落盘按用户名分目录', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-multi-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const srv = await startServer({
    DSH_SYNC_TOKENS: 'alice:tok_a,bob:tok_b',
    DATA_DIR: dir,
  })
  t.after(() => srv.stop())

  // alice 写一个对象
  const put = await fetch(`${srv.base}/v1/sessions/mbp/alice-1.log.enc`, {
    method: 'PUT', headers: auth('tok_a'), body: 'alice-data',
  })
  assert.equal(put.status, 200)

  // bob 看不到 alice 的对象：列表为空，直接 GET 404
  const bobList = await fetch(`${srv.base}/v1/sessions`, { headers: auth('tok_b') })
  const bobObjects = (await bobList.json() as { objects: unknown[] }).objects
  assert.equal(bobObjects.length, 0)
  const bobGet = await fetch(`${srv.base}/v1/sessions/mbp/alice-1.log.enc`, { headers: auth('tok_b') })
  assert.equal(bobGet.status, 404)

  // alice 列表只见自己的对象；key 不带用户名前缀（客户端视角不变）
  const aliceList = await fetch(`${srv.base}/v1/sessions`, { headers: auth('tok_a') })
  const aliceObjects = (await aliceList.json() as { objects: { key: string }[] }).objects
  assert.deepEqual(aliceObjects.map((o) => o.key), ['sessions/mbp/alice-1.log.enc'])

  // bob 在同名 key 下写自己的数据，互不覆盖
  const bobPut = await fetch(`${srv.base}/v1/sessions/mbp/alice-1.log.enc`, {
    method: 'PUT', headers: auth('tok_b'), body: 'bob-data',
  })
  assert.equal(bobPut.status, 200)
  const aliceGet = await fetch(`${srv.base}/v1/sessions/mbp/alice-1.log.enc`, { headers: auth('tok_a') })
  assert.equal(await aliceGet.text(), 'alice-data')

  // 落盘按用户名分目录
  assert.ok(fs.existsSync(path.join(dir, 'alice', 'sessions/mbp/alice-1.log.enc')))
  assert.ok(fs.existsSync(path.join(dir, 'bob', 'sessions/mbp/alice-1.log.enc')))

  // 错误 token 401
  const bad = await fetch(`${srv.base}/v1/sessions`, { headers: auth('wrong') })
  assert.equal(bad.status, 401)
})

test('配对校验：X-DSH-User 与租户名不一致 403，一致/缺失 200，单用户模式忽略', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-pair-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const srv = await startServer({
    DSH_SYNC_TOKENS: 'alice:tok_a,bob:tok_b',
    DATA_DIR: dir,
  })
  t.after(() => srv.stop())

  // 用户名与 token 配对正确
  const ok = await fetch(`${srv.base}/v1/sessions`, { headers: { ...auth('tok_a'), 'X-DSH-User': 'alice' } })
  assert.equal(ok.status, 200)
  // token 有效但用户名不配对 → 403
  const mismatch = await fetch(`${srv.base}/v1/sessions`, { headers: { ...auth('tok_a'), 'X-DSH-User': 'bob' } })
  assert.equal(mismatch.status, 403)
  // 头缺失 → 维持现状（老客户端兼容）
  const absent = await fetch(`${srv.base}/v1/sessions`, { headers: auth('tok_a') })
  assert.equal(absent.status, 200)

  // 单用户模式不校验该头（tenant 名是内部细节）
  const single = await startServer({ DSH_SYNC_TOKEN: 'legacy-tok', DATA_DIR: dir })
  t.after(() => single.stop())
  const ignored = await fetch(`${single.base}/v1/sessions`, {
    headers: { ...auth('legacy-tok'), 'X-DSH-User': 'whoever' },
  })
  assert.equal(ignored.status, 200)
})

test('多用户：非法配置进程退出', () => {
  const cases = [
    'alice',              // 缺冒号
    'alice:',             // 空 token
    ':tok',               // 空用户名
    'al ice:tok',         // 用户名含非法字符
    'alice:tok,alice:t2', // 重复用户名
    'alice:tok,bob:tok',  // 重复 token
  ]
  for (const value of cases) {
    const r = spawnSync(process.execPath, ['--import', 'tsx', SERVER], {
      env: { ...process.env, DSH_SYNC_TOKENS: value, DATA_DIR: os.tmpdir() },
      timeout: 30_000,
    })
    assert.notEqual(r.status, 0, `expected exit for DSH_SYNC_TOKENS="${value}"`)
  }
  // 与 DSH_SYNC_TOKEN 互斥
  const r = spawnSync(process.execPath, ['--import', 'tsx', SERVER], {
    env: { ...process.env, DSH_SYNC_TOKENS: 'a:t1', DSH_SYNC_TOKEN: 't0', DATA_DIR: os.tmpdir() },
    timeout: 30_000,
  })
  assert.notEqual(r.status, 0)
})

test('单用户兼容：DSH_SYNC_TOKEN 数据仍落 DATA_DIR 根', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dcs-single-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const srv = await startServer({ DSH_SYNC_TOKEN: 'legacy-tok', DATA_DIR: dir })
  t.after(() => srv.stop())

  const put = await fetch(`${srv.base}/v1/sessions/mbp/s.log.enc`, {
    method: 'PUT', headers: auth('legacy-tok'), body: 'data',
  })
  assert.equal(put.status, 200)
  // 不存在 <default>/ 子目录，对象在根下——存量部署布局不变
  assert.ok(fs.existsSync(path.join(dir, 'sessions/mbp/s.log.enc')))
  assert.ok(!fs.existsSync(path.join(dir, 'default')))
})
