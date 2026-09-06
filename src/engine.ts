import { logger } from 'node-karin'
import { start, stop, status, screenshot, screenshotTiles, daemon, cache } from '@shotkit/shotium'
import { pluginName } from './config/index'

import type {
  ScreenshotOptions,
  ScreenshotResult,
  ScreenshotTilesOptions,
  ScreenshotTilesResult,
  DaemonClient,
  StartOptions,
} from '@shotkit/shotium'
import type { ShotiumConfig } from './config/index'

/**
 * 渲染引擎
 */
export interface Engine {
  /** 截图 */
  screenshot: (options: ScreenshotOptions) => Promise<ScreenshotResult>
  /**
   * 分片截图
   *
   * 引擎自己把一次渲染的结果切成若干横条：文档只加载、布局、光栅化一次，
   * 每一片单独编码，同一时刻只存在一片的位图。
   */
  screenshotTiles: (options: ScreenshotTilesOptions) => Promise<ScreenshotTilesResult>
  /** 关闭 */
  close: () => Promise<void>
}

/**
 * 把插件配置里和引擎启动有关的部分挑出来
 * @param config 插件配置
 * @returns 引擎启动参数
 */
const toStartOptions = (config: ShotiumConfig): StartOptions => {
  const options: StartOptions = {
    cacheMaxBytes: config.cacheMaxBytes,
  }
  /**
   * 留空是「用引擎默认目录」，`off` 才是「关掉」——两者不能混为一谈。
   * 默认开着：模板拉远端图片时，一次冷 https 请求的钱比整张图的渲染还贵。
   */
  const cacheDir = (config.cacheDir ?? '').trim()
  if (cacheDir === 'off') {
    options.cacheDir = null
  } else if (cacheDir) {
    options.cacheDir = cacheDir
  }
  if (config.userAgent) options.userAgent = config.userAgent
  return options
}

/**
 * 进程内引擎
 *
 * 引擎本身就跑在 node 进程里，没有 IPC，单张开销最小；
 * 代价是引擎的内存算在 karin 头上。
 *
 * @param config 插件配置
 * @returns 引擎
 */
const createInprocessEngine = (config: ShotiumConfig): Engine => {
  const result = start(toStartOptions(config))
  logger.info(
    `[${pluginName}] 进程内引擎已启动: cache=${result.cacheActive ? result.cacheDir : '已关闭'}`
  )

  return {
    screenshot: (options) => screenshot(options),
    screenshotTiles: (options) => screenshotTiles(options),
    close: async () => {
      if (status().running) await stop()
    },
  }
}

/**
 * 常驻守护进程引擎
 *
 * 引擎跑在独立进程里，karin 重启不用重新付冷启动的钱；
 * 连接断了会自动重连，重连失败才把错误抛给调用方。
 *
 * @param config 插件配置
 * @returns 引擎
 */
const createDaemonEngine = (config: ShotiumConfig): Engine => {
  let client: DaemonClient | null = null
  let pending: Promise<DaemonClient> | null = null

  const connect = async (): Promise<DaemonClient> => {
    if (client) return client
    if (!pending) {
      pending = daemon
        .connect({
          ...toStartOptions(config),
          idleTimeoutMs: config.idleTimeoutMs,
        })
        .then((connected) => {
          client = connected
          connected.once('close', () => {
            client = null
            logger.warn(`[${pluginName}] 守护进程连接已断开，下次截图时会重连`)
          })
          logger.info(`[${pluginName}] 守护进程引擎已连接`)
          return connected
        })
        .finally(() => {
          pending = null
        })
    }
    return pending
  }

  /**
   * 拿到连接再做事，失败时重连一次
   *
   * 连接层面的问题重连一次再试，渲染本身的报错会在第二次原样抛出。
   *
   * @param run 拿到连接之后要做的事
   * @returns run 的结果
   */
  const call = async <T>(run: (client: DaemonClient) => Promise<T>): Promise<T> => {
    try {
      return await run(await connect())
    } catch {
      client = null
      return await run(await connect())
    }
  }

  return {
    screenshot: (options) => call((connected) => connected.screenshot(options)),
    screenshotTiles: (options) => call((connected) => connected.screenshotTiles(options)),
    close: async () => {
      client?.close()
      client = null
    },
  }
}

/**
 * 创建引擎
 * @param config 插件配置
 * @returns 引擎
 */
export const createEngine = (config: ShotiumConfig): Engine => {
  return config.mode === 'daemon'
    ? createDaemonEngine(config)
    : createInprocessEngine(config)
}

export { cache }
