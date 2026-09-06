/**
 * M3 e2e 云端种子：用独立口令（seed-pass）向参考服务端上传一套完整对象
 * （kdf sidecar + 一个会话的 log.enc/meta.enc），用于验证设置卡的
 * 「口令不匹配」与「已连接 · 云端 N 个会话」两类状态。
 * 用法：E2E_SERVER_URL=… E2E_TOKEN=… node --import tsx seed-cloud.mts
 */
import { zstdCompressSync } from 'node:zlib'
import {
  KDF_DEFAULTS,
  LogEncryptor,
  deriveKey,
  encodeKdfSidecar,
  encryptMeta,
  generateSalt,
} from '../../../src/crypto/envelope.js'
import { SyncClient } from '../../../src/sync/http-client.js'

const serverUrl = process.env.E2E_SERVER_URL ?? 'http://127.0.0.1:8871'
const token = process.env.E2E_TOKEN ?? 'e2e-token'
const device = process.env.E2E_DEVICE ?? 'e2e-device'
const passphrase = process.env.E2E_SEED_PASSPHRASE ?? 'seed-pass'
const sessionId = process.env.E2E_SEED_SESSION ?? 'seed-session-1'

const client = new SyncClient({ serverUrl, token, timeoutMs: 5000 })

// 幂等：kdf sidecar 已存在说明种子已就位——覆写会轮换 salt，
// 让此前上传的对象全部解不开（口令校验会误报 passphraseMismatch）
import { ProtocolError } from '../../../src/sync/http-client.js'
try {
  await client.download(`keys/${device}/kdf.json`)
  console.log(`SEED-SKIP device=${device} 已存在，不重复种子`)
  process.exit(0)
} catch (error) {
  if (!(error instanceof ProtocolError && error.status === 404)) throw error
}

const salt = generateSalt()
const key = deriveKey(passphrase, salt, KDF_DEFAULTS)

await client.overwrite(`keys/${device}/kdf.json`, encodeKdfSidecar(salt, KDF_DEFAULTS))

// 合法 zstd 单帧的会话文件（header + 一个标题事件），恢复/解密路径可真实读
const jsonl = `${JSON.stringify({ type: 'session/header', version: 0, id: sessionId, cwd: '/tmp', createdAt: Date.now() })}\n${JSON.stringify({ type: 'session/title', title: 'Seeded Session' })}\n`
const frame = zstdCompressSync(Buffer.from(jsonl, 'utf8'))
const encryptor = new LogEncryptor(key, salt, sessionId, 0)
const logPayload = Buffer.concat([encryptor.objectHeader(), encryptor.append(frame)])
await client.overwrite(`sessions/${device}/${sessionId}.log.enc`, logPayload)

await client.overwrite(
  `sessions/${device}/${sessionId}.meta.enc`,
  encryptMeta(key, salt, sessionId, {
    sessionId,
    title: 'Seeded Session',
    createdAt: Date.now(),
    updatedAt: Date.now(),
    eventCount: 2,
    formatVersion: 0,
    cwd: '/tmp',
    device,
  }),
)
console.log(`SEED-OK device=${device} session=${sessionId} passphrase=${passphrase}`)
