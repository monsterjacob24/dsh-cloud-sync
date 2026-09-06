/**
 * zstd 帧结构扫描与事件折叠（M2 上行链路只读本地会话文件）。
 *
 * scanZstdFrames 复刻自 dsh（packages/session/session-persistence-jsonl/src/zstd.ts），
 * 纯结构扫描不解压；帧边界即 dsh 的提交边界（每事件批次一个完整帧）。
 * 事件折叠按存储行解码规则自行计数：chunk 行（text-chunks 等）一行打包多个事件，
 * 按 data.texts/data.args 长度计数（与 decodeStorageRecord 的展开数一致）。
 */
import { promisify } from 'node:util'
import { constants, zstdCompress, zstdDecompress } from 'node:zlib'

export const ZSTD_MAGIC = 0xfd2fb528
export const zstdCompressAsync = promisify(zstdCompress)
export const zstdDecompressAsync = promisify(zstdDecompress)

/** 与 dsh 一致：压缩帧带 checksum（compressZstdFrame 的 CHECKSUM_OPTIONS）。 */
export const ZSTD_CHECKSUM_OPTIONS = { params: { [constants.ZSTD_c_checksumFlag]: 1 } }

export interface ZstdFrameRange {
  start: number
  end: number
}

export interface ZstdFrameScan {
  frames: ZstdFrameRange[]
  tornStart?: number
}

export function scanZstdFrames(buffer: Buffer, maxFrames = Number.POSITIVE_INFINITY): ZstdFrameScan {
  const frames: ZstdFrameRange[] = []
  let offset = 0

  while (offset < buffer.length) {
    const start = offset
    if (buffer.length - offset < 4) return { frames, tornStart: start }
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) {
      throw new Error(`corrupt Zstandard session log: invalid frame magic at byte ${offset}`)
    }
    offset += 4

    if (offset === buffer.length) return { frames, tornStart: start }
    const descriptor = buffer.readUInt8(offset)
    offset += 1
    if ((descriptor & 0x18) !== 0) {
      throw new Error(`corrupt Zstandard session log: reserved frame-header bit at byte ${offset - 1}`)
    }

    const contentSizeFlag = descriptor >>> 6
    const singleSegment = (descriptor & 0x20) !== 0
    const checksum = (descriptor & 0x04) !== 0
    const dictionaryFlag = descriptor & 0x03
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes
    if (buffer.length - offset < remainingHeaderBytes) return { frames, tornStart: start }
    offset += remainingHeaderBytes

    for (;;) {
      if (buffer.length - offset < 3) return { frames, tornStart: start }
      const blockHeader = buffer.readUIntLE(offset, 3)
      offset += 3
      const lastBlock = (blockHeader & 1) !== 0
      const blockType = (blockHeader >>> 1) & 0x03
      const blockSize = blockHeader >>> 3
      if (blockType === 0x03) {
        throw new Error(`corrupt Zstandard session log: reserved block type at byte ${offset - 3}`)
      }
      const payloadBytes = blockType === 0x01 ? 1 : blockSize
      if (buffer.length - offset < payloadBytes) return { frames, tornStart: start }
      offset += payloadBytes
      if (lastBlock) break
    }

    if (checksum) {
      if (buffer.length - offset < 4) return { frames, tornStart: start }
      offset += 4
    }
    frames.push({ start, end: offset })
    if (frames.length === maxFrames) return { frames }
  }

  return { frames }
}

/** 会话文件的物理编码检测：zstd 魔数或明文（`compression: none` profile）。 */
export function detectEncoding(prefix: Buffer): 'zstd' | 'plain' {
  return prefix.length >= 4 && prefix.readUInt32LE(0) === ZSTD_MAGIC ? 'zstd' : 'plain'
}

/** 事件折叠累积器：标题 latest-wins，updatedAt 取最大事件时间，事件按解码后计数。 */
export interface MetaFold {
  title?: string
  updatedAt: number
  eventCount: number
}

export function emptyFold(): MetaFold {
  return { updatedAt: 0, eventCount: 0 }
}

const CHUNK_ROW_TYPES = new Set(['text-chunks', 'reasoning-chunks', 'tool-call-chunks'])

/**
 * 把一段完整帧解压后的 JSONL 明文折叠进 meta 累积器。
 * 会话首帧的首行是 header 行（type 'session'），跳过不计数。
 */
export function foldPlaintext(plaintext: Buffer, acc: MetaFold): void {
  const text = plaintext.toString('utf8')
  for (const line of text.split('\n')) {
    if (line.length === 0) continue
    const row = JSON.parse(line) as Record<string, unknown>
    const type = row.type
    if (type === 'session') continue // header 行
    if (typeof type !== 'string') throw new Error('corrupt event row: missing type')

    if (CHUNK_ROW_TYPES.has(type)) {
      const data = row.data as { texts?: unknown[]; args?: unknown[]; dt?: number[] }
      const count = (data.texts ?? data.args ?? []).length
      acc.eventCount += count
      const time0 = typeof row.time0 === 'number' ? (row.time0 as number) : undefined
      if (time0 !== undefined) {
        const dt = Array.isArray(data.dt) ? data.dt.reduce((a, b) => a + b, 0) : 0
        acc.updatedAt = Math.max(acc.updatedAt, time0 + dt)
      }
    } else {
      acc.eventCount += 1
      if (typeof row.time === 'number') acc.updatedAt = Math.max(acc.updatedAt, row.time)
      if (type === 'session/title') {
        const data = row.data as { title?: unknown }
        if (typeof data.title === 'string') acc.title = data.title
      }
    }
  }
}

/** 解压一个完整帧并折叠。 */
export async function foldFrame(frameBytes: Buffer, acc: MetaFold): Promise<void> {
  foldPlaintext(await zstdDecompressAsync(frameBytes), acc)
}
