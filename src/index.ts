import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { karin, logger, registerRender, renderTpl } from 'node-karin'
import { karinPathHtml } from 'node-karin/root'
import { createEngine } from './engine'
import { splitPng } from './png'
import { isBridgeAvailable, toBridgeUrl, toFileUrl } from './bridge'
import { pickUnsupported, toScreenshotOptions, toSliceHeight } from './convert'
import { getConfig, pluginName, pluginVersion, HMR_KEY } from './config/index'

import type { Snapka } from 'node-karin'
import type { Engine } from './engine'
import type { ShotiumConfig } from './config/index'

/** 注册到 karin 的渲染器 ID */
const RENDER_ID = '@karinjs/plugin-shotium'
/** html 字符串落盘的目录 */
const stringHtmlDir = path.join(karinPathHtml, 'shotium')

/** 不支持的选项只提示一次，避免刷屏 */
const warned = new Set<string>()

/**
 * 提示一次
 * @param key 去重用的 key
 * @param message 提示内容
 */
const warnOnce = (key: string, message: string) => {
  if (warned.has(key)) return
  warned.add(key)
  logger.warn(`[${pluginName}] ${message}`)
}

/**
 * 把 html 字符串落盘
 *
 * shotium 只认 http/https/file 和本地路径，`data:` 会被直接拒绝，
 * 所以字符串形式的模板必须先写成文件。
 *
 * @param html html 字符串
 * @param name 文件名前缀
 * @returns 文件绝对路径
 */
const writeHtmlString = (html: string, name?: string): string => {
  fs.mkdirSync(stringHtmlDir, { recursive: true })
  const hash = crypto.createHash('md5').update(html).digest('hex').slice(0, 8)
  const file = path.join(stringHtmlDir, `${name || 'render'}-${hash}.html`)
  if (!fs.existsSync(file)) fs.writeFileSync(file, html)
  return file
}

/**
 * 决定最终交给引擎的地址
 *
 * @param file `renderTpl` 处理之后的地址
 * @param config 插件配置
 * @param hasHeaders 调用方是否传了自定义请求头
 * @returns 引擎地址、以及是否需要放开 `file://` 子资源
 */
const resolveTarget = (
  file: string,
  config: ShotiumConfig,
  hasHeaders: boolean
): { target: string, allowFileAccess: boolean } => {
  if (/^https?:\/\//.test(file)) {
    return { target: file, allowFileAccess: false }
  }

  const local = file.startsWith('file:') ? fileURLToPath(file) : path.resolve(file)

  /**
   * `auto`: 默认走 file——本地模板里的 `file://` 子资源不用改写就能读到，最省事。
   * 只有调用方传了自定义请求头时才切到 http：引擎只对同源子资源发头，
   * `file://` 文档没有同源可言，headers 会被整个丢掉。
   */
  const wantHttp = config.localAccess === 'http' || (config.localAccess === 'auto' && hasHeaders)

  if (wantHttp) {
    if (isBridgeAvailable()) {
      return { target: toBridgeUrl(local), allowFileAccess: false }
    }
    warnOnce('bridge', 'karin 的 http 服务不可用，本地文件已回退到 file:// 方式')
  }

  return { target: toFileUrl(local), allowFileAccess: true }
}

/**
 * 人类可读的体积
 * @param bytes 字节数
 * @returns 带单位的字符串
 */
const formatBytes = (bytes: number): string => {
  const units = ['B', 'KB', 'MB', 'GB']
  if (!bytes || bytes < 0) return '0 B'
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)))
  const value = bytes / Math.pow(1024, i)
  return `${i === 0 ? Math.round(value) : value.toFixed(2)} ${units[i]}`
}

const main = async () => {
  let config = getConfig()
  let engine: Engine = createEngine(config)

  karin.on(HMR_KEY, async () => {
    logger.info(`[${pluginName}] 检测到配置热更新，正在重建引擎...`)
    const previous = engine
    config = getConfig()
    engine = createEngine(config)
    await previous.close().catch(() => {})
    logger.info(`[${pluginName}] 引擎重建完成`)
  })

  registerRender(RENDER_ID, async (options: Snapka) => {
    const time = Date.now()

    if (options.file_type && options.file_type !== 'auto') {
      if (options.file_type === 'htmlString') {
        options.file = writeHtmlString(options.file, options.file_name)
        options.file_type = 'auto'
      } else {
        throw new Error(
          `[${pluginName}] shotium 没有 JS 运行时，无法渲染 file_type: ${options.file_type}，` +
          '请先在插件侧完成 SSR 再把 html 交过来'
        )
      }
    }

    /** 交给 karin 处理 art-template 与路径规范化，行为与 puppeteer 渲染器保持一致 */
    options.encoding = 'base64'
    const data = renderTpl(options as never) as Snapka

    const unsupported = pickUnsupported(data)
    if (unsupported.length > 0) {
      warnOnce(
        `unsupported:${unsupported.join(',')}`,
        `以下选项在 shotium 下无效，已忽略: ${unsupported.join('、')}（引擎不带 JS 运行时）`
      )
    }

    const hasHeaders = !!data.headers && Object.keys(data.headers).length > 0
    const { target, allowFileAccess } = resolveTarget(data.file, config, hasHeaders)
    const shot = toScreenshotOptions(data, config)
    const sliceHeight = toSliceHeight(data.multiPage, config.autoMultiPageHeight)

    /** 分片是对同一张图做无损切割，切割器只认 png */
    if (sliceHeight > 0 && shot.type !== 'png') {
      warnOnce(
        'multiPageType',
        `分片渲染只能输出 png，本次已把 ${shot.type} 切换为 png`
      )
      shot.type = 'png'
      delete shot.quality
    }

    const result = await engine.screenshot({ ...shot, file: target, allowFileAccess })
    const image = result.image
    if (!image) throw new Error(`[${pluginName}] 引擎没有返回图片数据`)

    /** karin 的 path 语义是「顺手存一份」，返回值仍然是 base64 */
    if (data.path) {
      fs.mkdirSync(path.dirname(path.resolve(data.path)), { recursive: true })
      fs.writeFileSync(path.resolve(data.path), image)
    }

    const name = path.basename(data.file_name || data.file || 'unknown')
    const stats = config.logStats
      ? ` 网络: ${result.stats.requests}(缓存 ${result.stats.fromCache}/失败 ${result.stats.failed})` +
        ` 引擎: ${result.stats.timing.total.toFixed(1)}ms`
      : ''

    if (sliceHeight === 0) {
      logger.info(
        `[${RENDER_ID}][${name}] 截图完成 大小: ${logger.green(formatBytes(image.length))} ` +
        `耗时: ${logger.green(String(Date.now() - time))} ms${stats}`
      )
      return image.toString('base64') as never
    }

    /** multiPage 给的是 css 像素，切割发生在设备像素上，要乘回缩放 */
    const list = splitPng(image, Math.round(sliceHeight * (shot.scale ?? 1)), config.sliceCompression)
    if (!list) {
      warnOnce('split', '当前图片格式无法分片，已按整张返回')
      return [image.toString('base64')] as never
    }

    logger.info(
      `[${RENDER_ID}][${name}] 分片截图完成 ${list.length} 张 ` +
      `大小: ${logger.green(formatBytes(image.length))} ` +
      `耗时: ${logger.green(String(Date.now() - time))} ms${stats}`
    )

    return list.map(item => item.toString('base64')) as never
  })

  logger.info(
    `${logger.violet(`[插件:${pluginVersion}]`)} ${logger.green(pluginName)} 初始化完成~`
  )
}

main()

export * from './config/index'
export * from './convert'
export * from './png'
