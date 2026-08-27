import zlib from 'node:zlib'
import { describe, it, expect } from 'vitest'
import { readPngInfo, splitPng } from './png'

const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

const crc32 = (buf: Buffer) => {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

const chunk = (type: string, data: Buffer) => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body), 0)
  return Buffer.concat([length, body, crc])
}

/**
 * 造一张 RGBA 测试图，每一行的红色通道等于行号，方便断言切出来的是哪几行
 */
const makePng = (width: number, height: number, filterType = 0) => {
  const stride = width * 4
  const body = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    body[y * (stride + 1)] = filterType
    for (let x = 0; x < width; x++) {
      const at = y * (stride + 1) + 1 + x * 4
      /** Sub 过滤器下写差分值，还原之后同一行内颜色一致 */
      body[at] = filterType === 1 && x > 0 ? 0 : y
      body[at + 1] = 0
      body[at + 2] = 0
      body[at + 3] = 255
    }
  }

  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8
  ihdr[9] = 6

  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(body)),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

/** 取出某一行第一个像素的红色通道 */
const readFirstPixelRed = (png: Buffer, row: number) => {
  const info = readPngInfo(png)!
  const stride = info.width * 4
  /** 分片出来的图统一是 filter 0，直接读即可 */
  const raw = zlib.inflateSync(
    (() => {
      let offset = 8
      const parts: Buffer[] = []
      while (offset + 8 <= png.length) {
        const length = png.readUInt32BE(offset)
        const type = png.toString('ascii', offset + 4, offset + 8)
        if (type === 'IDAT') parts.push(png.subarray(offset + 8, offset + 8 + length))
        offset += length + 12
      }
      return Buffer.concat(parts)
    })()
  )
  return raw[row * (stride + 1) + 1]
}

describe('readPngInfo', () => {
  it('读出宽高与色彩类型', () => {
    const info = readPngInfo(makePng(4, 10))
    expect(info).toMatchObject({ width: 4, height: 10, bitDepth: 8, colorType: 6 })
  })

  it('不是 png 时返回 null', () => {
    expect(readPngInfo(Buffer.from('hello world'))).toBeNull()
  })
})

describe('splitPng', () => {
  it('按高度切开，最后一片是余数', () => {
    const list = splitPng(makePng(4, 10), 4)!
    expect(list).toHaveLength(3)
    expect(readPngInfo(list[0])).toMatchObject({ width: 4, height: 4 })
    expect(readPngInfo(list[2])).toMatchObject({ width: 4, height: 2 })
  })

  it('切片高度不小于原图时原样返回', () => {
    const png = makePng(4, 10)
    expect(splitPng(png, 10)).toEqual([png])
    expect(splitPng(png, 999)).toEqual([png])
  })

  it('切出来的像素和原图对得上', () => {
    const list = splitPng(makePng(4, 10), 4)!
    /** 第二片的第一行应当是原图第 4 行 */
    expect(readFirstPixelRed(list[1], 0)).toBe(4)
    expect(readFirstPixelRed(list[2], 1)).toBe(9)
  })

  it('原图用了 Sub 过滤器也能正确还原', () => {
    const list = splitPng(makePng(4, 10, 1), 5)!
    expect(list).toHaveLength(2)
    expect(readFirstPixelRed(list[1], 0)).toBe(5)
  })

  it('不是 png 时返回 null 交给调用方回退', () => {
    expect(splitPng(Buffer.from('not a png'), 100)).toBeNull()
  })
})
