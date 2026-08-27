import zlib from 'node:zlib'

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/** colorType -> 通道数 */
const CHANNELS: Record<number, number> = {
  0: 1, // 灰度
  2: 3, // RGB
  4: 2, // 灰度 + alpha
  6: 4, // RGBA
}

/** crc32 查表 */
const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c
  }
  return table
})()

/**
 * 计算 crc32
 * @param buf 数据
 * @returns crc32
 */
const crc32 = (buf: Buffer): number => {
  let c = -1
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  }
  return (c ^ -1) >>> 0
}

/** 一个 PNG 分块 */
interface PngChunk {
  type: string
  data: Buffer
}

/**
 * 解析 PNG 的全部分块
 * @param buf PNG 数据
 * @returns 分块列表，不是合法 PNG 时返回 null
 */
const readChunks = (buf: Buffer): PngChunk[] | null => {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null

  const chunks: PngChunk[] = []
  let offset = 8

  while (offset + 8 <= buf.length) {
    const length = buf.readUInt32BE(offset)
    const type = buf.toString('ascii', offset + 4, offset + 8)
    const start = offset + 8
    const end = start + length
    if (end + 4 > buf.length) return null
    chunks.push({ type, data: buf.subarray(start, end) })
    offset = end + 4
    if (type === 'IEND') break
  }

  return chunks
}

/**
 * 组装一个 PNG 分块
 * @param type 分块类型
 * @param data 分块数据
 * @returns 带长度与 crc 的完整分块
 */
const writeChunk = (type: string, data: Buffer): Buffer => {
  const length = Buffer.alloc(4)
  length.writeUInt32BE(data.length, 0)
  const typeAndData = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(typeAndData), 0)
  return Buffer.concat([length, typeAndData, crc])
}

/** PNG 基本信息 */
export interface PngInfo {
  width: number
  height: number
  bitDepth: number
  colorType: number
  interlace: number
}

/**
 * 读取 PNG 的宽高等基本信息
 * @param buf PNG 数据
 * @returns 基本信息，不是合法 PNG 时返回 null
 */
export const readPngInfo = (buf: Buffer): PngInfo | null => {
  if (buf.length < 33 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) return null
  if (buf.toString('ascii', 12, 16) !== 'IHDR') return null

  return {
    width: buf.readUInt32BE(16),
    height: buf.readUInt32BE(20),
    bitDepth: buf[24],
    colorType: buf[25],
    interlace: buf[28],
  }
}

/**
 * Paeth 预测器
 */
const paeth = (a: number, b: number, c: number): number => {
  const p = a + b - c
  const pa = Math.abs(p - a)
  const pb = Math.abs(p - b)
  const pc = Math.abs(p - c)
  if (pa <= pb && pa <= pc) return a
  if (pb <= pc) return b
  return c
}

/**
 * 还原被过滤的扫描线
 * @param filtered 解压后的原始数据（每行含 1 字节过滤器标记）
 * @param width 宽度
 * @param height 高度
 * @param bpp 每像素字节数
 * @returns 去掉过滤器标记的连续像素数据
 */
const unfilter = (filtered: Buffer, width: number, height: number, bpp: number): Buffer => {
  const stride = width * bpp
  const out = Buffer.alloc(stride * height)

  for (let y = 0; y < height; y++) {
    const filterType = filtered[y * (stride + 1)]
    const src = y * (stride + 1) + 1
    const dst = y * stride
    const up = dst - stride

    for (let x = 0; x < stride; x++) {
      const raw = filtered[src + x]
      const a = x >= bpp ? out[dst + x - bpp] : 0
      const b = y > 0 ? out[up + x] : 0
      const c = x >= bpp && y > 0 ? out[up + x - bpp] : 0

      let value: number
      switch (filterType) {
        case 0: value = raw; break
        case 1: value = raw + a; break
        case 2: value = raw + b; break
        case 3: value = raw + ((a + b) >> 1); break
        case 4: value = raw + paeth(a, b, c); break
        default: value = raw
      }
      out[dst + x] = value & 0xff
    }
  }

  return out
}

/**
 * 把一张 PNG 按高度切成若干张 PNG
 *
 * 与「改视窗高度重新截图」相比，这里是对同一次渲染结果做无损切割：
 * 不会重新布局，也就不会出现分片之间样式对不上的问题。
 *
 * @param buf 原始 PNG
 * @param sliceHeight 每片高度(设备像素)
 * @param level deflate 级别 0-9，越低越快、体积越大
 * @returns 切好的 PNG 列表；无法处理时返回 null，由调用方回退
 */
export const splitPng = (buf: Buffer, sliceHeight: number, level = 3): Buffer[] | null => {
  const info = readPngInfo(buf)
  if (!info) return null
  /** 隔行扫描、非 8 位深、调色板图都不处理，交给调用方回退 */
  if (info.interlace !== 0 || info.bitDepth !== 8) return null

  const channels = CHANNELS[info.colorType]
  if (!channels) return null

  const height = Math.max(1, Math.floor(sliceHeight))
  if (height >= info.height) return [buf]

  const chunks = readChunks(buf)
  if (!chunks) return null

  const idat = chunks.filter(item => item.type === 'IDAT').map(item => item.data)
  if (idat.length === 0) return null

  let raw: Buffer
  try {
    raw = zlib.inflateSync(Buffer.concat(idat))
  } catch {
    return null
  }

  const stride = info.width * channels
  if (raw.length < (stride + 1) * info.height) return null

  const pixels = unfilter(raw, info.width, info.height, channels)

  /** 需要一并带到分片里的辅助分块 */
  const extras = chunks.filter(item => ['PLTE', 'tRNS', 'gAMA', 'sRGB', 'cHRM', 'iCCP', 'pHYs'].includes(item.type))

  const list: Buffer[] = []
  for (let top = 0; top < info.height; top += height) {
    const sliceRows = Math.min(height, info.height - top)

    /** 重新加上过滤器标记，统一使用 0(None)，交给 deflate 去压 */
    const body = Buffer.alloc((stride + 1) * sliceRows)
    for (let y = 0; y < sliceRows; y++) {
      body[y * (stride + 1)] = 0
      pixels.copy(body, y * (stride + 1) + 1, (top + y) * stride, (top + y + 1) * stride)
    }

    const ihdr = Buffer.alloc(13)
    ihdr.writeUInt32BE(info.width, 0)
    ihdr.writeUInt32BE(sliceRows, 4)
    ihdr[8] = info.bitDepth
    ihdr[9] = info.colorType
    ihdr[10] = 0
    ihdr[11] = 0
    ihdr[12] = 0

    list.push(Buffer.concat([
      PNG_SIGNATURE,
      writeChunk('IHDR', ihdr),
      ...extras.map(item => writeChunk(item.type, item.data)),
      writeChunk('IDAT', zlib.deflateSync(body, { level })),
      writeChunk('IEND', Buffer.alloc(0)),
    ]))
  }

  return list
}
