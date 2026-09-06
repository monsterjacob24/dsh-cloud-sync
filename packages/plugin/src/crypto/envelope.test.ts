import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  HEADER_LENGTH,
  KDF_DEFAULTS,
  LogEncryptor,
  decodeKdfSidecar,
  decryptLog,
  decryptMeta,
  deriveKey,
  encodeKdfSidecar,
  encryptMeta,
  generateSalt,
  verifyTailSegment,
  type SessionMeta,
} from './envelope.ts'

const PASSPHRASE = 'correct horse battery staple'
const SESSION_ID = 's_01HZYTEST0000000000000001'

function makeKey(salt: Buffer, passphrase = PASSPHRASE) {
  return deriveKey(passphrase, salt, KDF_DEFAULTS)
}

/** 构造一个三段的数据对象，返回字节与各段切片。 */
function makeLog(salt: Buffer, key: Buffer, parts: Buffer[], sessionId = SESSION_ID) {
  const enc = new LogEncryptor(key, salt, sessionId)
  const segments = parts.map((p) => enc.append(p))
  return { bytes: Buffer.concat([enc.objectHeader(), ...segments]), segments }
}

describe('kdf', () => {
  it('同 passphrase + salt 派生稳定密钥', () => {
    const salt = generateSalt()
    assert.deepEqual(makeKey(salt), makeKey(salt))
  })

  it('sidecar 往返', () => {
    const salt = generateSalt()
    const decoded = decodeKdfSidecar(encodeKdfSidecar(salt))
    assert.deepEqual(decoded.salt, salt)
    assert.deepEqual(decoded.params, KDF_DEFAULTS)
  })
})

describe('数据对象链式加解密', () => {
  it('多段往返', () => {
    const salt = generateSalt()
    const key = makeKey(salt)
    const parts = [Buffer.from('frame-0 bytes'), Buffer.alloc(1024, 7), Buffer.from('frame-2')]
    const { bytes } = makeLog(salt, key, parts)
    assert.deepEqual(decryptLog(key, SESSION_ID, bytes), Buffer.concat(parts))
  })

  it('断点续加密：从中段序号恢复 encryptor，链保持有效', () => {
    const salt = generateSalt()
    const key = makeKey(salt)
    const first = new LogEncryptor(key, salt, SESSION_ID)
    const seg0 = first.append(Buffer.from('a'))
    const seg1 = first.append(Buffer.from('b'))
    // 模拟进程重启后从 state 恢复：序号 2、prevTag = seg1 的 tag
    const resumed = new LogEncryptor(key, salt, SESSION_ID, 2, first.lastTag)
    const seg2 = resumed.append(Buffer.from('c'))
    const bytes = Buffer.concat([resumed.objectHeader(), seg0, seg1, seg2])
    assert.deepEqual(decryptLog(key, SESSION_ID, bytes), Buffer.from('abc'))
  })

  it('拒绝坏 magic 与过短对象', () => {
    const salt = generateSalt()
    const key = makeKey(salt)
    const { bytes } = makeLog(salt, key, [Buffer.from('x')])
    assert.throws(() => decryptLog(key, SESSION_ID, bytes.subarray(0, HEADER_LENGTH - 1)))
    const badMagic = Buffer.from(bytes)
    badMagic[0] ^= 0xff
    assert.throws(() => decryptLog(key, SESSION_ID, badMagic))
  })
})

describe('攻击向量（必须全部解密失败）', () => {
  const salt = generateSalt()
  const key = makeKey(salt)
  const parts = [Buffer.from('segment zero'), Buffer.from('segment one'), Buffer.from('segment two')]
  const { bytes, segments } = makeLog(salt, key, parts)
  const header = bytes.subarray(0, HEADER_LENGTH)

  it('段内截断（长度字段越界 / 尾部缺字节）', () => {
    assert.throws(() => decryptLog(key, SESSION_ID, bytes.subarray(0, bytes.length - 5)))
  })

  it('段边界截断产生合法前缀对象（密码学不可检，尾段丢失由 meta eventCount 交叉校验发现）', () => {
    const cut = bytes.subarray(0, bytes.length - segments[2].length)
    assert.deepEqual(decryptLog(key, SESSION_ID, cut), Buffer.concat(parts.slice(0, 2)))
  })

  it('重排段', () => {
    const reordered = Buffer.concat([header, segments[1], segments[0], segments[2]])
    assert.throws(() => decryptLog(key, SESSION_ID, reordered))
  })

  it('拼接另一对象的段', () => {
    const other = makeLog(salt, key, [Buffer.from('foreign a'), Buffer.from('foreign b')])
    const spliced = Buffer.concat([header, segments[0], other.segments[1]])
    assert.throws(() => decryptLog(key, SESSION_ID, spliced))
  })

  it('同 salt 不同 sessionId 的段拼接', () => {
    const other = makeLog(salt, key, [Buffer.from('a'), Buffer.from('b')], 's_other')
    const spliced = Buffer.concat([header, segments[0], other.segments[1]])
    assert.throws(() => decryptLog(key, SESSION_ID, spliced))
  })

  it('错误 passphrase', () => {
    assert.throws(() => decryptLog(makeKey(salt, 'wrong'), SESSION_ID, bytes))
  })

  it('错误 sessionId（AAD 输入）', () => {
    assert.throws(() => decryptLog(key, 's_wrong', bytes))
  })
})

describe('409 幂等尾段校验', () => {
  it('校验通过返回明文', () => {
    const salt = generateSalt()
    const key = makeKey(salt)
    const enc = new LogEncryptor(key, salt, SESSION_ID)
    enc.append(Buffer.from('first'))
    const prevTag = enc.lastTag
    const tail = enc.append(Buffer.from('second'))
    const plaintext = verifyTailSegment(key, SESSION_ID, 1, prevTag, tail)
    assert.deepEqual(plaintext, Buffer.from('second'))
  })

  it('prevTag 不符即失败', () => {
    const salt = generateSalt()
    const key = makeKey(salt)
    const enc = new LogEncryptor(key, salt, SESSION_ID)
    enc.append(Buffer.from('first'))
    const tail = enc.append(Buffer.from('second'))
    assert.throws(() => verifyTailSegment(key, SESSION_ID, 1, null, tail)) // 段 1 的 prevTag 不是全零
  })
})

describe('元数据对象', () => {
  const meta: SessionMeta = {
    sessionId: SESSION_ID,
    title: '整理 repo 结构',
    createdAt: 1756581000000,
    updatedAt: 1756612000000,
    eventCount: 412,
    formatVersion: 0,
    cwd: '/Users/x/github-project/deepseek-harness',
    device: 'mbp-14',
  }

  it('往返（含中文标题）', () => {
    const salt = generateSalt()
    const key = makeKey(salt)
    const bytes = encryptMeta(key, salt, SESSION_ID, meta)
    assert.deepEqual(decryptMeta(key, SESSION_ID, bytes), meta)
    // 密文不含明文标题与路径
    assert.equal(bytes.includes(Buffer.from(meta.title, 'utf8')), false)
    assert.equal(bytes.includes(Buffer.from(meta.cwd, 'utf8')), false)
  })

  it('错误 passphrase 失败', () => {
    const salt = generateSalt()
    const bytes = encryptMeta(makeKey(salt), salt, SESSION_ID, meta)
    assert.throws(() => decryptMeta(makeKey(salt, 'wrong'), SESSION_ID, bytes))
  })
})
