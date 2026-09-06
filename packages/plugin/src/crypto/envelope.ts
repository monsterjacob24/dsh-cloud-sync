/**
 * dsh-cloud-sync 加密信封（protocol v1，见 docs/03-server-protocol.md §5）。
 *
 * 字节布局：
 *   数据对象：magic "DCS1"(4) + kdf salt(16) + 加密段*，段顺序即段序号
 *   每段：    段密文长度 L uint32BE(4) + nonce(12) + 密文(L) + GCM tag(16)
 *   元数据对象：magic + salt + 单个段（AAD "meta|<sessionId>"）
 *
 * 链式 AAD：log 段 i 的 AAD = "log|<sessionId>|<i>|<hex(prevTag)>"，
 * i=0 时 prevTag 为 32 个字符 "0"。截断、重排、跨对象拼接均解密失败。
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto'

export const MAGIC = Buffer.from('DCS1')
export const SALT_LENGTH = 16
export const HEADER_LENGTH = MAGIC.length + SALT_LENGTH
export const NONCE_LENGTH = 12
export const TAG_LENGTH = 16
const LENGTH_FIELD = 4
/** 段固定开销：长度字段 + nonce + tag */
export const SEGMENT_OVERHEAD = LENGTH_FIELD + NONCE_LENGTH + TAG_LENGTH

export interface KdfParams {
  N: number
  r: number
  p: number
}

export const KDF_DEFAULTS: KdfParams = { N: 2 ** 15, r: 8, p: 1 }

export function generateSalt(): Buffer {
  return randomBytes(SALT_LENGTH)
}

export function deriveKey(passphrase: string, salt: Buffer, params: KdfParams = KDF_DEFAULTS): Buffer {
  if (salt.length !== SALT_LENGTH) throw new Error(`salt must be ${SALT_LENGTH} bytes`)
  // Node 默认 maxmem=32MB 不够 N=2^15,r=8（需 128*N*r*p ≈ 32MB 外加余量）
  const maxmem = Math.max(64 * 1024 * 1024, 256 * params.N * params.r * params.p)
  return scryptSync(passphrase, salt, 32, { N: params.N, r: params.r, p: params.p, maxmem })
}

/** `keys/<device>/kdf.json` 侧车对象：存 scrypt 参数与 salt（不含密钥材料）。 */
export interface KdfSidecar extends KdfParams {
  salt: string // hex
}

export function encodeKdfSidecar(salt: Buffer, params: KdfParams = KDF_DEFAULTS): Buffer {
  return Buffer.from(JSON.stringify({ salt: salt.toString('hex'), ...params }), 'utf8')
}

export function decodeKdfSidecar(bytes: Buffer): { salt: Buffer; params: KdfParams } {
  const parsed = JSON.parse(bytes.toString('utf8')) as KdfSidecar
  const salt = Buffer.from(parsed.salt, 'hex')
  if (salt.length !== SALT_LENGTH) throw new Error('invalid salt in kdf sidecar')
  return { salt, params: { N: parsed.N, r: parsed.r, p: parsed.p } }
}

const ZERO_TAG_HEX = '0'.repeat(TAG_LENGTH * 2)

function logAad(sessionId: string, index: number, prevTagHex: string): Buffer {
  return Buffer.from(`log|${sessionId}|${index}|${prevTagHex}`, 'utf8')
}

function metaAad(sessionId: string): Buffer {
  return Buffer.from(`meta|${sessionId}`, 'utf8')
}

function sealSegment(key: Buffer, nonce: Buffer, aad: Buffer, plaintext: Buffer): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, nonce)
  cipher.setAAD(aad)
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()])
  const tag = cipher.getAuthTag()
  const header = Buffer.alloc(LENGTH_FIELD + NONCE_LENGTH)
  header.writeUInt32BE(ciphertext.length, 0)
  nonce.copy(header, LENGTH_FIELD)
  return Buffer.concat([header, ciphertext, tag])
}

function openSegment(key: Buffer, aad: Buffer, segment: Buffer): { plaintext: Buffer; tag: Buffer } {
  if (segment.length < SEGMENT_OVERHEAD) throw new Error('truncated segment')
  const length = segment.readUInt32BE(0)
  if (segment.length !== SEGMENT_OVERHEAD + length) {
    throw new Error(`segment length mismatch: field=${length}, actual=${segment.length - SEGMENT_OVERHEAD}`)
  }
  const nonce = segment.subarray(LENGTH_FIELD, LENGTH_FIELD + NONCE_LENGTH)
  const ciphertext = segment.subarray(LENGTH_FIELD + NONCE_LENGTH, LENGTH_FIELD + NONCE_LENGTH + length)
  const tag = segment.subarray(segment.length - TAG_LENGTH)
  const decipher = createDecipheriv('aes-256-gcm', key, nonce)
  decipher.setAAD(aad)
  decipher.setAuthTag(tag)
  try {
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()])
    return { plaintext, tag: Buffer.from(tag) }
  } catch {
    throw new Error('segment authentication failed')
  }
}

function checkHeader(bytes: Buffer, context: string): void {
  if (bytes.length < HEADER_LENGTH) throw new Error(`${context}: object too short`)
  if (!bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error(`${context}: bad magic`)
}

/**
 * 数据对象的增量加密器。一次上传 = `append(完整 zstd 帧区间)` 产出一个段，
 * 段字节直接 PUT append 到服务端对象尾部。
 */
export class LogEncryptor {
  private index: number
  private prevTagHex: string

  constructor(
    private key: Buffer,
    private salt: Buffer,
    private sessionId: string,
    startIndex = 0,
    prevTag?: Buffer,
  ) {
    if (salt.length !== SALT_LENGTH) throw new Error(`salt must be ${SALT_LENGTH} bytes`)
    this.index = startIndex
    this.prevTagHex = prevTag ? prevTag.toString('hex') : ZERO_TAG_HEX
  }

  /** 新对象的文件头（magic + salt），仅在首传时写入一次。 */
  objectHeader(): Buffer {
    return Buffer.concat([MAGIC, this.salt])
  }

  get segmentIndex(): number {
    return this.index
  }

  get lastTag(): Buffer {
    return Buffer.from(this.prevTagHex, 'hex')
  }

  /** 加密一段明文（完整 zstd 帧的字节区间），返回可追加的段字节。 */
  append(plaintext: Buffer): Buffer {
    const aad = logAad(this.sessionId, this.index, this.prevTagHex)
    const segment = sealSegment(this.key, randomBytes(NONCE_LENGTH), aad, plaintext)
    this.prevTagHex = segment.subarray(segment.length - TAG_LENGTH).toString('hex')
    this.index += 1
    return segment
  }
}

/** 解密完整数据对象（恢复路径）：校验 magic/salt，逐段链式解密。 */
export function decryptLog(key: Buffer, sessionId: string, bytes: Buffer): Buffer {
  checkHeader(bytes, 'log')
  const parts: Buffer[] = []
  let offset = HEADER_LENGTH
  let index = 0
  let prevTagHex = ZERO_TAG_HEX
  while (offset < bytes.length) {
    if (bytes.length - offset < SEGMENT_OVERHEAD) throw new Error('truncated: incomplete trailing segment')
    const length = bytes.readUInt32BE(offset)
    const end = offset + SEGMENT_OVERHEAD + length
    if (end > bytes.length) throw new Error('truncated: segment extends past end of object')
    const { plaintext, tag } = openSegment(key, logAad(sessionId, index, prevTagHex), bytes.subarray(offset, end))
    parts.push(plaintext)
    prevTagHex = tag.toString('hex')
    index += 1
    offset = end
  }
  return Buffer.concat(parts)
}

/**
 * 409 幂等判定（见 docs/02 §10）：下载服务端末段，以预期 AAD 校验解密。
 * 返回明文供与本地比对；任何不匹配抛错。
 */
export function verifyTailSegment(
  key: Buffer,
  sessionId: string,
  segmentIndex: number,
  prevTag: Buffer | null,
  segmentBytes: Buffer,
): Buffer {
  const prevTagHex = prevTag ? prevTag.toString('hex') : ZERO_TAG_HEX
  return openSegment(key, logAad(sessionId, segmentIndex, prevTagHex), segmentBytes).plaintext
}

export interface SessionMeta {
  sessionId: string
  title: string
  createdAt: number
  updatedAt: number
  eventCount: number
  /** 来源会话的 SESSION_FORMAT_VERSION（SessionHeader.version），M4 版本门禁用 */
  formatVersion: number
  cwd: string
  device: string
}

export function encryptMeta(key: Buffer, salt: Buffer, sessionId: string, meta: SessionMeta): Buffer {
  const plaintext = Buffer.from(JSON.stringify(meta), 'utf8')
  return Buffer.concat([MAGIC, salt, sealSegment(key, randomBytes(NONCE_LENGTH), metaAad(sessionId), plaintext)])
}

export function decryptMeta(key: Buffer, sessionId: string, bytes: Buffer): SessionMeta {
  checkHeader(bytes, 'meta')
  const { plaintext } = openSegment(key, metaAad(sessionId), bytes.subarray(HEADER_LENGTH))
  return JSON.parse(plaintext.toString('utf8')) as SessionMeta
}
