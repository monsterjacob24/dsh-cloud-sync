/**
 * kdf 引导单测（docs/03 §5.1）：本机 sidecar 直连、跨设备发现（验证采纳/
 * 无会话采纳/验证失败回退新 salt）、无 sidecar 新建。
 */
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeKdfSidecar, decryptMeta, deriveKey, encryptMeta, encodeKdfSidecar, generateSalt, type SessionMeta } from '../crypto/envelope.js'
import type { RemoteObject } from './http-client.js'
import { ProtocolError } from './http-client.js'
import { bootstrapKdf } from './kdf.js'

/** 内存哑存储客户端：key → bytes。 */
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
    if (!bytes) throw new ProtocolError(404, 'not found')
    return bytes
  }
  async overwrite(key: string, content: Buffer): Promise<void> {
    this.objects.set(key, Buffer.from(content))
  }
}

const PASS = 'shared-pass'
const WRONG = 'wrong-pass'

function makeMeta(sessionId: string): SessionMeta {
  return {
    sessionId,
    title: 't',
    createdAt: 1,
    updatedAt: 2,
    eventCount: 1,
    formatVersion: 0,
    cwd: '/p',
    device: 'device-a',
  }
}

/** 放一台设备名下的 sidecar + 用它加密的一个 meta 对象。 */
function seedDevice(client: FakeClient, device: string, passphrase: string): { salt: Buffer } {
  const salt = generateSalt()
  client.objects.set(`keys/${device}/kdf.json`, encodeKdfSidecar(salt))
  const key = deriveKey(passphrase, salt)
  client.objects.set(`sessions/${device}/s-1.meta.enc`, encryptMeta(key, salt, 's-1', makeMeta('s-1')))
  return { salt }
}

test('本机 sidecar 存在 → 直接使用，不写任何对象', async () => {
  const client = new FakeClient()
  const { salt } = seedDevice(client, 'mac', PASS)
  const before = client.objects.size

  const result = await bootstrapKdf({ client: client as never, device: 'mac', passphrase: PASS })
  assert.deepEqual(result.salt, salt)
  assert.deepEqual(result.key, deriveKey(PASS, salt))
  assert.equal(client.objects.size, before, '不得新建或改写对象')
})

test('本机缺失 + 他机同口令 → 验证采纳并镜像写回本机名下', async () => {
  const client = new FakeClient()
  const { salt } = seedDevice(client, 'pc-a', PASS)
  const adopts: string[] = []

  const result = await bootstrapKdf({ client: client as never, device: 'pc-b', passphrase: PASS, onAdopt: (m) => adopts.push(m) })
  assert.deepEqual(result.salt, salt, '应采纳他机 salt')
  assert.ok(client.objects.get('keys/pc-b/kdf.json'), '应镜像写回本机 sidecar')
  assert.equal(adopts.length, 1)
  assert.match(adopts[0], /通过/)

  // 采纳后能直接解他机 meta（恢复目录可用）
  const key = deriveKey(PASS, salt)
  decryptMeta(key, 's-1', client.objects.get('sessions/pc-a/s-1.meta.enc')!)
})

test('本机缺失 + 他机口令不符 → 不采纳，生成新 salt 上传本机名下', async () => {
  const client = new FakeClient()
  seedDevice(client, 'pc-a', PASS) // 他机口令与本机输入不同

  const result = await bootstrapKdf({ client: client as never, device: 'pc-b', passphrase: WRONG })
  assert.notDeepEqual(result.salt, client.objects.get('keys/pc-a/kdf.json'))
  assert.ok(client.objects.get('keys/pc-b/kdf.json'), '应上传本机新 sidecar')
  assert.deepEqual(result.key, deriveKey(WRONG, result.salt))
})

test('多台他机 sidecar：逐个试派生，跳过口令不符的采纳匹配的', async () => {
  const client = new FakeClient()
  // device-x 用另一口令（排前面），device-a 用本机口令
  const otherSalt = generateSalt()
  client.objects.set('keys/device-x/kdf.json', encodeKdfSidecar(otherSalt))
  const keyX = deriveKey('another-pass', otherSalt)
  client.objects.set('sessions/device-x/x-1.meta.enc', encryptMeta(keyX, otherSalt, 'x-1', makeMeta('x-1')))
  const { salt } = seedDevice(client, 'device-a', PASS)

  const result = await bootstrapKdf({ client: client as never, device: 'pc-b', passphrase: PASS })
  assert.deepEqual(result.salt, salt, '应采纳 device-a（口令匹配），跳过 device-x')
  assert.deepEqual(client.objects.get('keys/pc-b/kdf.json'), client.objects.get('keys/device-a/kdf.json'))
})

test('本机缺失 + 他机 sidecar 但云端无 meta → 无验证采纳首个候选', async () => {
  const client = new FakeClient()
  const salt = generateSalt()
  client.objects.set('keys/pc-a/kdf.json', encodeKdfSidecar(salt))

  const adopts: string[] = []
  const result = await bootstrapKdf({ client: client as never, device: 'pc-b', passphrase: PASS, onAdopt: (m) => adopts.push(m) })
  assert.deepEqual(result.salt, salt)
  assert.ok(client.objects.get('keys/pc-b/kdf.json'))
  assert.match(adopts[0]!, /跳过/)
})

test('云端没有任何 sidecar → 生成新 salt 上传', async () => {
  const client = new FakeClient()

  const result = await bootstrapKdf({ client: client as never, device: 'solo', passphrase: PASS })
  const written = client.objects.get('keys/solo/kdf.json')
  assert.ok(written, '应上传本机 sidecar')
  assert.deepEqual(decodeKdfSidecar(written).salt, result.salt, '写回的 sidecar 应与返回的 salt 一致')
  assert.deepEqual(result.key, deriveKey(PASS, result.salt))
})
