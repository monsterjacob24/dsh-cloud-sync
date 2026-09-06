import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import type { Config } from '../config.ts'
import { configKey } from '../index.ts'

function baseConfig(): Config {
  return {
    serverUrl: 'http://localhost:8787',
    token: 'tok',
    passphrase: 'pass',
    deviceName: 'dev',
    autoUpload: true,
    checkOnStartup: true,
    uploadDebounceMs: 3000,
    pollIntervalMs: 30000,
    requestTimeoutMs: 15000,
  }
}

describe('configKey 守卫', () => {
  it('通道字段（已拆到 cloud-sync-status namespace）不影响 configKey（双保险）', () => {
    const base = configKey(baseConfig())
    // 模拟旧版单 namespace 布局里混入的通道字段：一律不参与 configKey
    const mutated = {
      ...baseConfig(),
      statusPhase: 'failed',
      statusCloudCount: 99,
      statusLastSyncAt: 1,
      statusCheckedAt: 1,
      statusError: 'unreachable',
      statusErrorDetail: 'other',
      tokenConfigured: false,
      passphraseConfigured: false,
      statusSyncAllAt: 1,
      statusSyncAllOk: 1,
      statusSyncAllFailed: 1,
      statusSyncAllError: 'y',
      testRequestedAt: 999,
      syncAllRequestedAt: 999,
    } as Config
    assert.equal(configKey(mutated), base)
  })

  it('改 9 个用户配置字段之一 configKey 变化', () => {
    const base = baseConfig()
    const baseKey = configKey(base)
    const variants: Config[] = [
      { ...base, serverUrl: 'http://other:8787' },
      { ...base, token: 'tok2' },
      { ...base, passphrase: 'pass2' },
      { ...base, deviceName: 'dev2' },
      { ...base, autoUpload: false },
      { ...base, checkOnStartup: false },
      { ...base, uploadDebounceMs: 5000 },
      { ...base, pollIntervalMs: 60000 },
      { ...base, requestTimeoutMs: 30000 },
    ]
    for (const variant of variants) {
      assert.notEqual(configKey(variant), baseKey)
    }
  })
})
