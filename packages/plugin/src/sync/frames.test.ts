import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import {
  ZSTD_CHECKSUM_OPTIONS,
  detectEncoding,
  emptyFold,
  foldPlaintext,
  scanZstdFrames,
  zstdCompressAsync,
  zstdDecompressAsync,
} from './frames.ts'

async function frame(lines: string[]): Promise<Buffer> {
  return zstdCompressAsync(Buffer.from(lines.join('\n') + '\n', 'utf8'), ZSTD_CHECKSUM_OPTIONS)
}

describe('scanZstdFrames', () => {
  it('多帧扫描返回完整边界', async () => {
    const a = await frame(['{"type":"session"}'])
    const b = await frame(['{"type":"user/message"}'])
    const scan = scanZstdFrames(Buffer.concat([a, b]))
    assert.deepEqual(scan.frames, [
      { start: 0, end: a.length },
      { start: a.length, end: a.length + b.length },
    ])
    assert.equal(scan.tornStart, undefined)
  })

  it('半帧（写入中）报 tornStart 且不计入完整帧', async () => {
    const a = await frame(['x'])
    const b = await frame(['y'.repeat(100)])
    const torn = Buffer.concat([a, b.subarray(0, 10)])
    const scan = scanZstdFrames(torn)
    assert.equal(scan.frames.length, 1)
    assert.equal(scan.tornStart, a.length)
  })

  it('非 zstd 字节抛错', () => {
    assert.throws(() => scanZstdFrames(Buffer.from('not zstd at all...')))
  })
})

describe('detectEncoding', () => {
  it('zstd magic / 明文', async () => {
    const f = await frame(['x'])
    assert.equal(detectEncoding(f.subarray(0, 4)), 'zstd')
    assert.equal(detectEncoding(Buffer.from('{"ty')), 'plain')
  })
})

describe('foldPlaintext（事件折叠）', () => {
  it('header 行跳过，普通事件计数并取最大 time', () => {
    const acc = emptyFold()
    foldPlaintext(
      Buffer.from(
        [
          '{"type":"session","version":0,"id":"s_1","createdAt":1,"delegationDepth":0}',
          '{"type":"user/message","seq":0,"time":100,"data":{}}',
          '{"type":"assistant/message","seq":1,"time":200,"data":{}}',
          '',
        ].join('\n'),
        'utf8',
      ),
      acc,
    )
    assert.equal(acc.eventCount, 2)
    assert.equal(acc.updatedAt, 200)
    assert.equal(acc.title, undefined)
  })

  it('session/title latest-wins', () => {
    const acc = emptyFold()
    foldPlaintext(Buffer.from('{"type":"session/title","seq":0,"time":1,"data":{"title":"旧"}}\n'), acc)
    foldPlaintext(Buffer.from('{"type":"session/title","seq":1,"time":2,"data":{"title":"新"}}\n'), acc)
    assert.equal(acc.title, '新')
    assert.equal(acc.eventCount, 2)
  })

  it('chunk 行按打包事件数计数，时间为 time0+sum(dt)', () => {
    const acc = emptyFold()
    foldPlaintext(
      Buffer.from(
        '{"type":"text-chunks","seq0":5,"time0":1000,"data":{"turn":0,"step":0,"index":0,"dt":[10,20,30],"texts":["a","b","c"]}}\n',
        'utf8',
      ),
      acc,
    )
    assert.equal(acc.eventCount, 3)
    assert.equal(acc.updatedAt, 1060)
  })

  it('帧解压往返（compress → decompress）', async () => {
    const f = await frame(['{"type":"user/message","seq":0,"time":1,"data":{}}'])
    const plain = await zstdDecompressAsync(f)
    const acc = emptyFold()
    foldPlaintext(plain, acc)
    assert.equal(acc.eventCount, 1)
  })
})
