/**
 * M4 e2e 断言脚本：读 $E2E_WORK 下的 catalog.json / result.json /
 * discovered.json / seed-frame2.hex，校验恢复链路端到端正确性。
 *
 * 断言点：
 * 1. 目录：error 为空、selfDevice 为本机设备、含 seed-session-1（device=e2e-device、
 *    existsLocal=false）；
 * 2. 结果：at 回显请求 at、ok=1、failed=0；路径映射已学习 {from: 来源 cwd, to: targetCwd}；
 * 3. 发现：persistence.list() 含 seed-session-1，header.cwd 已是 targetCwd，
 *    locate() 落位文件存在；
 * 4. 帧级：落位文件整体逐帧解压后 header 行 cwd 已改写且 id 不变；
 *    第二帧字节与种子明文第二帧（seed-frame2.hex）完全一致——
 *    证明 rewriteCwd 只动首帧（restore.ts §4.3 铁律 2）。
 *
 * 用法：E2E_WORK=… E2E_TARGET_CWD=… E2E_RESTORE_AT=… node --import tsx verify.mts
 */
import assert from 'node:assert'
import { existsSync, readFileSync, realpathSync } from 'node:fs'
import path from 'node:path'
import { scanZstdFrames, zstdDecompressAsync } from '../../../src/sync/frames.js'
import type { CatalogEntry, RestoreCatalog, RestoreResult } from '../../../src/sync/restore.js'

const work = process.env.E2E_WORK
assert.ok(work, 'E2E_WORK 未设置')
const targetCwd = process.env.E2E_TARGET_CWD
assert.ok(targetCwd, 'E2E_TARGET_CWD 未设置')
const restoreAt = Number(process.env.E2E_RESTORE_AT ?? '0')
assert.ok(restoreAt > 0, 'E2E_RESTORE_AT 未设置')
const sessionId = process.env.E2E_SEED_SESSION ?? 'seed-session-1'
const sourceDevice = process.env.E2E_DEVICE ?? 'e2e-device'
const localDevice = process.env.E2E_LOCAL_DEVICE ?? 'm4-local'
const sourceCwd = process.env.E2E_SEED_CWD ?? '/tmp/proj-a'

const readJson = (name: string): unknown => JSON.parse(readFileSync(path.join(work, name), 'utf8'))

// 1. 目录
const catalog = readJson('catalog.json') as RestoreCatalog
assert.strictEqual(catalog.error, '', `目录拉取报错：${catalog.error}`)
assert.strictEqual(catalog.selfDevice, localDevice, 'selfDevice 应为本机设备名')
const entry = catalog.sessions.find((s: CatalogEntry) => s.sessionId === sessionId)
assert.ok(entry, `目录中未找到 ${sessionId}`)
assert.strictEqual(entry.device, sourceDevice, '目录条目 device 应为种子设备')
assert.strictEqual(entry.existsLocal, false, '恢复前 existsLocal 应为 false')
assert.strictEqual(entry.cwd, sourceCwd, '目录条目 cwd 应为来源 cwd')
console.log('VERIFY-OK catalog')

// 2. 恢复结果 + 映射学习
const { result, pathMappings } = readJson('result.json') as {
  result: RestoreResult
  pathMappings: { from: string; to: string }[]
}
assert.strictEqual(result.at, restoreAt, 'restoreResultJson.at 未回显请求 at')
assert.strictEqual(result.ok, 1, `恢复成功数应为 1：${result.firstError}`)
assert.strictEqual(result.failed, 0, `恢复失败数应为 0：${result.firstError}`)
assert.deepStrictEqual(pathMappings, [{ from: sourceCwd, to: targetCwd }], '路径映射未按预期学习')
console.log('VERIFY-OK result')

// 3. 落位发现
const discovered = readJson('discovered.json') as {
  found: boolean
  header: { id: string; cwd?: string }
  path: string | null
}
assert.strictEqual(discovered.found, true, '恢复后会话未被 persistence.list() 发现')
assert.strictEqual(discovered.header.id, sessionId)
assert.strictEqual(discovered.header.cwd, targetCwd, '发现的 header.cwd 应为 targetCwd')
assert.ok(discovered.path, 'locate() 未给出落位路径')
assert.ok(existsSync(discovered.path), `落位文件不存在：${discovered.path}`)
console.log(`VERIFY-OK discovered path=${discovered.path}`)

// 3b. workspace 成员关系（web 侧边栏可见性）：恢复会话挂在 targetCwd 对应工作区
const workspace = readJson('workspace.json') as { attached: boolean; path: string }
assert.strictEqual(workspace.attached, true, '恢复会话未挂进任何 workspace')
assert.strictEqual(
  realpathSync(workspace.path),
  realpathSync(targetCwd),
  `workspace 路径 ${workspace.path} 应与 targetCwd ${targetCwd} 归一后一致`,
)
console.log(`VERIFY-OK workspace path=${workspace.path}`)

// 4. 帧级校验
const bytes = readFileSync(discovered.path)
const scan = scanZstdFrames(bytes)
assert.ok(scan.frames.length >= 2, `落位文件应至少两帧，实际 ${scan.frames.length}`)
assert.strictEqual(scan.tornStart, undefined, '落位文件存在残帧')

// 逐帧解压拼接（Node zstdDecompress 只解首帧，不能整体解）
const parts: Buffer[] = []
for (const frame of scan.frames) {
  parts.push(await zstdDecompressAsync(bytes.subarray(frame.start, frame.end)))
}
const text = Buffer.concat(parts).toString('utf8')
const headerLine = text.slice(0, text.indexOf('\n'))
const header = JSON.parse(headerLine) as { type?: string; id?: string; cwd?: string }
assert.strictEqual(header.type, 'session', '首行不是 session header')
assert.strictEqual(header.id, sessionId, 'header.id 被改写')
assert.strictEqual(header.cwd, targetCwd, 'header.cwd 未改写为 targetCwd')

const seedFrame2 = readFileSync(path.join(work, 'seed-frame2.hex'), 'utf8').trim()
const restoredFrame2 = bytes.subarray(scan.frames[1].start, scan.frames[1].end).toString('hex')
assert.strictEqual(restoredFrame2, seedFrame2, '第二帧字节与种子不一致（rewriteCwd 动了事件帧）')
const frame2Text = (await zstdDecompressAsync(bytes.subarray(scan.frames[1].start, scan.frames[1].end))).toString('utf8')
assert.ok(frame2Text.includes('"session/title"'), '第二帧内容不是 title 事件')
console.log('VERIFY-OK frames（首帧 cwd 已改写，第二帧字节原样）')

console.log(`M4-E2E-PASS session=${sessionId} cwd=${sourceCwd}→${targetCwd}`)
