/** 纯函数层单测（node:test；不 import React/tsx 组件，保证现有 test glob 直接可跑）。 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  canRunServerAction,
  catalogErrorKeyOf,
  defaultSelectedKeys,
  deviceOptions,
  encodeMappingDelete,
  encodeRestoreRequest,
  errorKeyOf,
  filterEntries,
  isRowRestorable,
  isValidDeviceName,
  isValidServerUrl,
  parseCatalog,
  parseMappings,
  parseRestoreResult,
  parseStartupNotice,
  projectStatusLine,
  relativeTime,
  rowKeyOf,
  triggerAction,
  TRIGGER_RETRY_MS,
  TRIGGER_TIMEOUT_MS,
} from './pure.ts'

test('isValidServerUrl：空串合法（未填），仅接受 http(s)', () => {
  assert.equal(isValidServerUrl(''), true)
  assert.equal(isValidServerUrl('http://192.168.1.10:8787'), true)
  assert.equal(isValidServerUrl('https://sync.example.com'), true)
  assert.equal(isValidServerUrl('ftp://x'), false)
  assert.equal(isValidServerUrl('not-a-url'), false)
  assert.equal(isValidServerUrl('example.com'), false)
})

test('isValidDeviceName：空串合法，字符集与长度受限', () => {
  assert.equal(isValidDeviceName(''), true)
  assert.equal(isValidDeviceName('alice-mbp'), true)
  assert.equal(isValidDeviceName('a'.repeat(32)), true)
  assert.equal(isValidDeviceName('a'.repeat(33)), false)
  assert.equal(isValidDeviceName('有空格'), false)
  assert.equal(isValidDeviceName('with space'), false)
  assert.equal(isValidDeviceName('slash/'), false)
})

test('relativeTime：0/负数表示从未同步，返回 null', () => {
  assert.equal(relativeTime(0, 1_000_000), null)
  assert.equal(relativeTime(-5, 1_000_000), null)
})

test('relativeTime：按分钟/小时/天分档', () => {
  const now = 1_000_000_000_000
  assert.deepEqual(relativeTime(now - 10_000, now), { key: 'time.justNow' })
  assert.deepEqual(relativeTime(now - 2 * 60_000, now), { key: 'time.minutesAgo', count: 2 })
  assert.deepEqual(relativeTime(now - 3 * 3_600_000, now), { key: 'time.hoursAgo', count: 3 })
  assert.deepEqual(relativeTime(now - 2 * 86_400_000, now), { key: 'time.daysAgo', count: 2 })
  // 未来时间戳（时钟漂移）按 0 差值处理，不出负数
  assert.deepEqual(relativeTime(now + 60_000, now), { key: 'time.justNow' })
})

test('projectStatusLine：unconfigured 直接落未配置态', () => {
  assert.deepEqual(
    projectStatusLine({ phase: 'unconfigured', error: '', errorDetail: '', cloudCount: 0, lastSyncAt: 0, now: 1 }),
    { kind: 'unconfigured' },
  )
})

test('projectStatusLine：failed 透传错误码与详情', () => {
  const line = projectStatusLine({
    phase: 'failed', error: 'tokenInvalid', errorDetail: '401', cloudCount: 0, lastSyncAt: 0, now: 1,
  })
  assert.deepEqual(line, { kind: 'failed', error: 'tokenInvalid', detail: '401' })
})

test('projectStatusLine：connected 带计数、相对时间与告警位', () => {
  const now = 1_000_000_000_000
  const ok = projectStatusLine({
    phase: 'connected', error: '', errorDetail: '', cloudCount: 23, lastSyncAt: now - 2 * 60_000, now,
  })
  assert.deepEqual(ok, {
    kind: 'connected', count: 23,
    lastSync: { key: 'time.minutesAgo', count: 2 },
    warn: false, error: '', detail: '',
  })
  // 连续推送失败：前缀告警 + 悬停详情（01 §5.2）
  const warn = projectStatusLine({
    phase: 'connected', error: 'syncFailed', errorDetail: 'boom', cloudCount: 1, lastSyncAt: 0, now,
  })
  assert.equal(warn.kind, 'connected')
  assert.equal(warn.warn, true)
  assert.equal(warn.lastSync, null)
  // 设备名冲突同样告警（01 §6）
  const conflict = projectStatusLine({
    phase: 'connected', error: 'deviceConflict', errorDetail: '', cloudCount: 1, lastSyncAt: 0, now,
  })
  assert.equal(conflict.kind === 'connected' && conflict.warn, true)
})

test('errorKeyOf：已知码映射专属文案，未知/空码落 error.unknown', () => {
  assert.equal(errorKeyOf('unreachable'), 'error.unreachable')
  assert.equal(errorKeyOf('tokenInvalid'), 'error.tokenInvalid')
  assert.equal(errorKeyOf('passphraseMismatch'), 'error.passphraseMismatch')
  assert.equal(errorKeyOf('deviceConflict'), 'error.deviceConflict')
  assert.equal(errorKeyOf('syncFailed'), 'error.unknown')
  assert.equal(errorKeyOf(''), 'error.unknown')
})

test('canRunServerAction：地址非法/为空或令牌不可用时禁用', () => {
  assert.equal(canRunServerAction('http://h:8787', true), true)
  assert.equal(canRunServerAction('http://h:8787', false), false)
  assert.equal(canRunServerAction('', true), false)
  assert.equal(canRunServerAction('not-a-url', true), false)
})

test('triggerAction：回显到达即完成（哪怕已超总超时）', () => {
  const issuedAt = 100_000
  assert.equal(triggerAction(issuedAt, issuedAt, issuedAt, issuedAt), 'done')
  // 迟到的回显不能把成功判成失败
  assert.equal(triggerAction(issuedAt + 1, issuedAt, issuedAt, issuedAt + TRIGGER_TIMEOUT_MS + 5_000), 'done')
})

test('triggerAction：距上次写满一个节拍且无回显则重发（同一 issuedAt）', () => {
  const issuedAt = 100_000
  assert.equal(triggerAction(0, issuedAt, issuedAt, issuedAt + TRIGGER_RETRY_MS), 'resend')
  assert.equal(triggerAction(0, issuedAt, issuedAt, issuedAt + 3 * TRIGGER_RETRY_MS), 'resend')
})

test('triggerAction：节拍未满则等待', () => {
  const issuedAt = 100_000
  assert.equal(triggerAction(0, issuedAt, issuedAt, issuedAt + TRIGGER_RETRY_MS - 1), 'wait')
})

test('triggerAction：20s 总超时退出', () => {
  const issuedAt = 100_000
  assert.equal(triggerAction(0, issuedAt, issuedAt, issuedAt + TRIGGER_TIMEOUT_MS), 'timeout')
  assert.equal(triggerAction(0, issuedAt, issuedAt + TRIGGER_TIMEOUT_MS - 100, issuedAt + TRIGGER_TIMEOUT_MS + 1), 'timeout')
})


// ---- M4：恢复流程的通道载荷与目录投影 ----

test('parseCatalog：合法载荷还原；空串/坏 JSON/缺字段按无数据处理', () => {
  const catalog = {
    at: 1,
    selfDevice: 'mac',
    sessions: [{
      sessionId: 's-1',
      device: 'device-a',
      title: 't',
      updatedAt: 100,
      eventCount: 3,
      cwd: '/home/alice/p/proj',
      formatVersion: 0,
      existsLocal: false,
      versionIncompatible: false,
      resolvedCwd: '/Users/bob/code/proj',
      resolution: 'suggested',
    }],
    error: '',
  }
  assert.deepEqual(parseCatalog(JSON.stringify(catalog)), catalog)
  assert.equal(parseCatalog(''), null)
  assert.equal(parseCatalog('not json'), null)
  assert.equal(parseCatalog('{"at":1}'), null)
})

test('parseRestoreResult / parseStartupNotice / parseMappings 防御性解析', () => {
  assert.deepEqual(parseRestoreResult('{"at":2,"ok":1,"failed":0,"firstError":""}'), { at: 2, ok: 1, failed: 0, firstError: '' })
  assert.equal(parseRestoreResult(''), null)
  assert.equal(parseRestoreResult('{"at":2}'), null)
  assert.deepEqual(parseStartupNotice('{"at":3,"count":2}'), { at: 3, count: 2 })
  assert.equal(parseStartupNotice('{"at":0,"count":2}'), null, 'at<=0 视为无通知')
  assert.deepEqual(parseMappings('[{"from":"/a","to":"/b"}]'), [{ from: '/a', to: '/b' }])
  assert.deepEqual(parseMappings('[]'), [])
  assert.deepEqual(parseMappings('[{"from":"/a"}]'), [], '缺字段的条目被过滤')
  assert.deepEqual(parseMappings('bad'), [])
})

test('encodeRestoreRequest / encodeMappingDelete 与 Host 解码契约一致', () => {
  assert.deepEqual(JSON.parse(encodeRestoreRequest(9, [{ sessionId: 's', device: 'd', targetCwd: null }])), {
    at: 9,
    items: [{ sessionId: 's', device: 'd', targetCwd: null }],
  })
  assert.deepEqual(JSON.parse(encodeMappingDelete(7, '/a')), { at: 7, from: '/a' })
})

test('rowKeyOf / isRowRestorable：行主键与禁用判定', () => {
  assert.equal(rowKeyOf({ device: 'd', sessionId: 's' }), 'd/s')
  assert.equal(isRowRestorable({ existsLocal: false, versionIncompatible: false }), true)
  assert.equal(isRowRestorable({ existsLocal: true, versionIncompatible: false }), false)
  assert.equal(isRowRestorable({ existsLocal: false, versionIncompatible: true }), false)
})

test('defaultSelectedKeys：默认勾选当前设备之外的可恢复行', () => {
  const entry = (sessionId: string, device: string, over: object = {}) => ({
    sessionId, device, title: '', updatedAt: 0, eventCount: 0, cwd: '', formatVersion: 0,
    existsLocal: false, versionIncompatible: false, resolvedCwd: null, resolution: 'none' as const,
    ...over,
  })
  const catalog = {
    at: 1,
    selfDevice: 'mac',
    sessions: [
      entry('s-1', 'device-a'),
      entry('s-2', 'mac'), // 当前设备：不默认勾
      entry('s-3', 'device-a', { existsLocal: true }), // 本地已存在：不默认勾
      entry('s-4', 'device-b', { versionIncompatible: true }), // 版本不兼容：不默认勾
    ],
    error: '',
  }
  assert.deepEqual(defaultSelectedKeys(catalog), ['device-a/s-1'])
  assert.deepEqual(deviceOptions(catalog), ['device-a', 'device-b', 'mac'])
})

test('filterEntries：按来源设备筛选，空 filter 返回全部', () => {
  const entry = (device: string) => ({
    sessionId: `s-${device}`, device, title: '', updatedAt: 0, eventCount: 0, cwd: '', formatVersion: 0,
    existsLocal: false, versionIncompatible: false, resolvedCwd: null, resolution: 'none' as const,
  })
  const entries = [entry('a'), entry('b'), entry('a')]
  assert.equal(filterEntries(entries, '').length, 3)
  assert.deepEqual(filterEntries(entries, 'a').map((e) => e.sessionId), ['s-a', 's-a'])
})

test('catalogErrorKeyOf：tokenInvalid / unconfigured 专属文案，其余落不可达', () => {
  assert.equal(catalogErrorKeyOf('tokenInvalid'), 'error.tokenInvalid')
  assert.equal(catalogErrorKeyOf('unconfigured'), 'status.unconfigured')
  assert.equal(catalogErrorKeyOf('unreachable'), 'error.unreachable')
  assert.equal(catalogErrorKeyOf('whatever'), 'error.unreachable')
})
