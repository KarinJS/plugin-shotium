import path from 'node:path'

import type { ScreenshotOptions } from '@shotkit/shotium'
import type { Snapka } from 'node-karin'
import type { ShotiumConfig } from './config/index'

/**
 * karin 里能传、但 shotium 做不到的选项
 *
 * shotium 砍掉了 V8，页面里没有脚本会跑，
 * 这些「等某个东西发生」的开关自然也就没有意义，遇到时提示一次即可。
 */
export const UNSUPPORTED_KEYS = [
  'waitForSelector',
  'waitForFunction',
  'waitForRequest',
  'waitForResponse',
] as const

/**
 * 把 karin 的 `waitUntil` 归一成 shotium 的两档
 *
 * @param waitUntil karin/puppeteer 的取值，可能是数组
 * @returns shotium 的取值
 */
export const toWaitUntil = (
  waitUntil?: string | string[]
): 'load' | 'networkidle' | undefined => {
  if (!waitUntil) return undefined
  const list = Array.isArray(waitUntil) ? waitUntil : [waitUntil]
  return list.some(item => item.startsWith('networkidle')) ? 'networkidle' : 'load'
}

/**
 * 把 karin 的截图参数翻译成 shotium 的截图参数
 *
 * 只做纯粹的字段映射，`file` 由调用方在外面决定用 `file://` 还是走 http 桥接。
 *
 * @param options karin 截图参数
 * @param config 插件配置
 * @returns shotium 截图参数（不含 `file`）
 */
export const toScreenshotOptions = (
  options: Snapka,
  config: ShotiumConfig
): Omit<ScreenshotOptions, 'file'> => {
  const type = options.type ?? config.type
  const result: Omit<ScreenshotOptions, 'file'> = { type }

  /** png 没有有损压缩这一说，带上 quality 反而会被引擎拒绝 */
  if (type !== 'png') {
    result.quality = options.quality ?? config.quality
  }

  /** fullPage 和 selector 在引擎里互斥，与 puppeteer 一致：fullPage 优先 */
  if (options.fullPage) {
    result.fullPage = true
  } else if (options.selector) {
    result.selector = options.selector
  }

  /** jpeg 没有 alpha 通道，透明底只对 png/webp 有意义 */
  if (options.omitBackground && type !== 'jpeg') {
    result.omitBackground = true
  }

  if (options.clip && !result.fullPage && !result.selector) {
    result.clip = {
      x: options.clip.x,
      y: options.clip.y,
      width: options.clip.width,
      height: options.clip.height,
    }
  }

  const width = options.setViewport?.width ?? config.viewport.width
  const height = options.setViewport?.height ?? config.viewport.height
  result.viewport = { width, height }

  const scale = options.setViewport?.deviceScaleFactor ?? config.scale
  if (scale && scale !== 1) result.scale = scale

  const waitUntil = toWaitUntil(options.pageGotoParams?.waitUntil)
  const timeout = options.pageGotoParams?.timeout
  if (waitUntil || typeof timeout === 'number') {
    result.pageGotoParams = {
      ...(waitUntil ? { waitUntil } : {}),
      /** puppeteer 用 0 表示不超时，shotium 没有这个约定，回退到默认值 */
      ...(typeof timeout === 'number' && timeout > 0 ? { timeout } : {}),
    }
  }

  if (options.headers && Object.keys(options.headers).length > 0) {
    result.headers = options.headers
  }

  return result
}

/**
 * 取出调用方传了、但引擎不支持的选项名
 * @param options karin 截图参数
 * @returns 选项名列表
 */
export const pickUnsupported = (options: Snapka): string[] => {
  return UNSUPPORTED_KEYS.filter(key => {
    const value = (options as unknown as Record<string, unknown>)[key]
    return Array.isArray(value) ? value.length > 0 : !!value
  })
}

/**
 * 引擎一次能从同一个滚动位置画出的最大 css 行数，也是 `tile.height` 的上限
 *
 * 超过这个值引擎会直接拒绝整个请求，所以这里夹住而不是原样传过去：
 * 调用方要的是「一片别太高」，不是「宁可不出图」。
 */
export const MAX_TILE_HEIGHT = 32000

/**
 * 计算每一片的高度(css px)
 * @param multiPage karin 的 multiPage 参数
 * @param autoHeight `true` 时使用的默认高度
 * @returns 分片高度，1 到 32000 之间的整数；不分片时返回 0
 */
export const toSliceHeight = (
  multiPage: number | boolean | undefined,
  autoHeight: number
): number => {
  const height = multiPage === true
    ? autoHeight
    : typeof multiPage === 'number' ? multiPage : 0
  if (!(height > 0)) return 0
  return Math.min(MAX_TILE_HEIGHT, Math.max(1, Math.round(height)))
}

/**
 * 分片落盘时每一片的路径
 *
 * 分片模式下没有「整张图」这个东西可以往 `path` 上写，所以按片编号存：
 * 路径里写了 `{n}` 就替换它，没写就把 1 起的序号插在扩展名前面。
 * 只有一片时按调用方给的路径原样存，退化成不分片时的行为。
 *
 * @param file 调用方给的路径
 * @param index 第几片，从 1 开始
 * @param total 一共几片
 * @returns 这一片的路径
 */
export const toTilePath = (file: string, index: number, total: number): string => {
  if (file.includes('{n}')) return file.split('{n}').join(String(index))
  if (total === 1) return file
  const ext = path.extname(file)
  return `${file.slice(0, file.length - ext.length)}-${index}${ext}`
}
