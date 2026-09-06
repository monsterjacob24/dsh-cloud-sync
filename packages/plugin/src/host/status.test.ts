import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { KDF_DEFAULTS, deriveKey, encodeKdfSidecar, encryptMeta, generateSalt } from '../crypto/envelope.ts'
import { runConnectionCheck } from '../status.ts'
import { ProtocolError, type RemoteObject, type SyncClient } from '../sync/http-client.ts'

const DEVICE = 'dev'
const PASSPHRASE = 'right passphrase'
const SALT = generateSalt()
const KEY = deriveKey(PASSPHRASE, SALT, KDF_DEFAULTS)

interface FakeHandlers {
  list?: (prefix?: string) => Promise<RemoteObject[]>
  download?: (key: string) => Promise<Buffer>
}

/** 假 SyncClient：status.ts 只用到 list/download。 */
function fakeClient(handlers: FakeHandlers): SyncClient {
  return handlers as unknown as SyncClient
}

function remote(key: string): RemoteObject {
  return { key, size: 1, revision: 'r', lastModified: '' }
}

/** 云端有一个用正确口令加密的 meta 对象的假 client。 */
function cloudWithOneSession(): SyncClient {
  const meta = encryptMeta(KEY, SALT, 's_1', {
    sessionId: 's_1',
    title: '标题',
    createdAt: 1000,
    updatedAt: 2000,
    eventCount: 3,
    formatVersion: 0,
    cwd: '/proj',
    device: DEVICE,
  })
  const objects = new Map<string, Buffer>([
    [`keys/${DEVICE}/kdf.json`, encodeKdfSidecar(SALT, KDF_DEFAULTS)],
    [`sessions/${DEVICE}/s_1.meta.enc`, meta],
  ])
  return fakeClient({
    async list(prefix?: string) {
      return [...objects.keys()].filter((k) => !prefix || k.startsWith(prefix)).map(remote)
    },
    async download(key: string) {
      const content = objects.get(key)
      if (!content) throw new ProtocolError(404, 'not found')
      return content
    },
  })
}

describe('runConnectionCheck 分类', () => {
  it('网络异常 → failed/unreachable', async () => {
    const client = fakeClient({
      list: () => Promise.reject(new TypeError('fetch failed')),
    })
    const result = await runConnectionCheck({ client, device: DEVICE, passphrase: PASSPHRASE })
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'unreachable')
    assert.ok(result.errorDetail.includes('fetch failed'))
  })

  it('401 → failed/tokenInvalid，403 → failed/userMismatch', async () => {
    const cases = [
      { status: 401, error: 'tokenInvalid' },
      { status: 403, error: 'userMismatch' },
    ] as const
    for (const { status, error } of cases) {
      const client = fakeClient({
        list: () => Promise.reject(new ProtocolError(status, `GET → ${status}`)),
      })
      const result = await runConnectionCheck({ client, device: DEVICE, passphrase: PASSPHRASE })
      assert.equal(result.phase, 'failed')
      assert.equal(result.error, error)
    }
  })

  it('其他 HTTP 错误 → failed/unreachable 且 detail 带状态码', async () => {
    const client = fakeClient({
      list: () => Promise.reject(new ProtocolError(500, 'GET → 500')),
    })
    const result = await runConnectionCheck({ client, device: DEVICE, passphrase: PASSPHRASE })
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'unreachable')
    assert.ok(result.errorDetail.includes('500'))
  })

  it('云端为空 → connected，cloudCount 0（不校验口令）', async () => {
    const client = fakeClient({
      list: () => Promise.resolve([]),
      download: () => Promise.reject(new Error('不应被调用：云端为空时跳过口令校验')),
    })
    const result = await runConnectionCheck({ client, device: DEVICE, passphrase: '' })
    assert.equal(result.phase, 'connected')
    assert.equal(result.cloudCount, 0)
    assert.equal(result.error, '')
  })

  it('云端有对象且口令正确 → connected，cloudCount 为 meta 对象数', async () => {
    const result = await runConnectionCheck({ client: cloudWithOneSession(), device: DEVICE, passphrase: PASSPHRASE })
    assert.equal(result.phase, 'connected')
    assert.equal(result.cloudCount, 1)
    assert.equal(result.error, '')
    assert.equal(result.errorDetail, '')
  })

  it('口令错误 → failed/passphraseMismatch', async () => {
    const result = await runConnectionCheck({ client: cloudWithOneSession(), device: DEVICE, passphrase: 'wrong' })
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'passphraseMismatch')
    assert.equal(result.cloudCount, 1)
  })

  it('会话存在但 kdf sidecar 404 → failed/passphraseMismatch（只读，不创建）', async () => {
    const client = fakeClient({
      list: () => Promise.resolve([remote(`sessions/${DEVICE}/s_1.meta.enc`)]),
      download: () => Promise.reject(new ProtocolError(404, 'not found')),
    })
    const result = await runConnectionCheck({ client, device: DEVICE, passphrase: PASSPHRASE })
    assert.equal(result.phase, 'failed')
    assert.equal(result.error, 'passphraseMismatch')
    assert.ok(result.errorDetail.includes('kdf sidecar'))
  })
})
