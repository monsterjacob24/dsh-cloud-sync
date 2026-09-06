/**
 * M4 e2e 云端种子：以 device=e2e-device、口令 seed-pass 种下会话
 * seed-session-1（来源 cwd /tmp/proj-a），供恢复流程验收。
 *
 * 与 m3 种子的关键差别：
 * - log 明文写成两个独立 zstd 帧（首帧仅 header 行，第二帧仅一个 title
 *   事件行），恢复改写首帧 cwd 后可断言第二帧字节原样未动（帧级断言；
 *   第二帧 hex 落盘 $E2E_WORK/seed-frame2.hex 供 verify.mts 比对）；
 * - header 用 dsh 真实形态（format.ts toHeaderLine：type 'session' +
 *   version/id/createdAt/cwd + 必填 delegationDepth）——m3 的
 *   'session/header' 形态过不了恢复路径 parseHeaderFromLog（restore.ts:163），
 *   也过不了 dsh list() 的 parseHeaderMeta（createdAt/delegationDepth 必填）。
 *
 * kdf sidecar 只种在种子设备名下（不做镜像）：M5 起 Host 的 kdf 引导支持
 * 跨设备发现（sync/kdf.ts：本机缺失时拉他机 kdf.json 逐个试派生，meta
 * 试解密验证后采纳并镜像写回本机名下），e2e 由此真实走到跨设备发现路径。
 *
 * 幂等：keys/<device>/kdf.json 已存在则跳过（覆写会轮换 salt，
 * 让此前上传的对象全部解不开）。
 *
 * 用法：E2E_SERVER_URL=… E2E_TOKEN=… E2E_WORK=… node --import tsx seed-cloud.mts
 */
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import { zstdCompressSync } from 'node:zlib'
import {
  KDF_DEFAULTS,
  LogEncryptor,
  deriveKey,
  encodeKdfSidecar,
  encryptMeta,
  generateSalt,
} from '../../../src/crypto/envelope.js'
import { ProtocolError, SyncClient } from '../../../src/sync/http-client.js'

const serverUrl = process.env.E2E_SERVER_URL ?? 'http://127.0.0.1:8872'
const token = process.env.E2E_TOKEN ?? 'e2e-token'
const device = process.env.E2E_DEVICE ?? 'e2e-device'
const passphrase = process.env.E2E_SEED_PASSPHRASE ?? 'seed-pass'
const sessionId = process.env.E2E_SEED_SESSION ?? 'seed-session-1'
const cwd = process.env.E2E_SEED_CWD ?? '/tmp/proj-a'
const work = process.env.E2E_WORK

const client = new SyncClient({ serverUrl, token, timeoutMs: 5000 })

// 幂等：kdf sidecar 已存在说明种子已就位
try {
  await client.download(`keys/${device}/kdf.json`)
  console.log(`SEED-SKIP device=${device} 已存在，不重复种子`)
  process.exit(0)
} catch (error) {
  if (!(error instanceof ProtocolError && error.status === 404)) throw error
}

const salt = generateSalt()
const key = deriveKey(passphrase, salt, KDF_DEFAULTS)
const sidecar = encodeKdfSidecar(salt, KDF_DEFAULTS)
const now = Date.now()

await client.overwrite(`keys/${device}/kdf.json`, sidecar)
// 不镜像到 m4-local：让 Host 走 kdf 跨设备发现（M5，见文件头注释）

// 首帧：仅 header 行（dsh toHeaderLine 真实形态；delegationDepth 必填）
const headerLine = JSON.stringify({
  type: 'session',
  version: 0,
  id: sessionId,
  createdAt: now,
  cwd,
  delegationDepth: 0,
}) + '\n'
// 第二帧：仅一个 title 事件行（存储行形态：type/seq/time/data）
const titleLine = JSON.stringify({
  type: 'session/title',
  seq: 0,
  time: now,
  data: { title: 'M4 恢复验收会话', messageSeqs: [], source: { kind: 'user' } },
}) + '\n'
const frame1 = zstdCompressSync(Buffer.from(headerLine, 'utf8'))
const frame2 = zstdCompressSync(Buffer.from(titleLine, 'utf8'))

const encryptor = new LogEncryptor(key, salt, sessionId, 0)
const logPayload = Buffer.concat([encryptor.objectHeader(), encryptor.append(frame1), encryptor.append(frame2)])
await client.overwrite(`sessions/${device}/${sessionId}.log.enc`, logPayload)

await client.overwrite(
  `sessions/${device}/${sessionId}.meta.enc`,
  encryptMeta(key, salt, sessionId, {
    sessionId,
    title: 'M4 恢复验收会话',
    createdAt: now,
    updatedAt: now,
    eventCount: 1, // 折叠计数不含 header 行（frames.ts foldPlaintext）
    formatVersion: 0,
    cwd,
    device,
  }),
)

// 帧级断言锚点：第二帧字节原样落盘，verify.mts 恢复后比对
if (work) {
  writeFileSync(path.join(work, 'seed-frame2.hex'), frame2.toString('hex'))
}
console.log(`SEED-OK device=${device} session=${sessionId} cwd=${cwd} frames=2`)
