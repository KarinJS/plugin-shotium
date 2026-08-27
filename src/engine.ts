import { logger } from 'node-karin'
import { start, stop, status, screenshot, daemon, cache } from '@shotkit/shotium'
import { pluginName } from './config/index'

import type { ScreenshotOptions, ScreenshotResult, DaemonClient, StartOptions } from '@shotkit/shotium'
import type { ShotiumConfig } from './config/index'

/**
 * 渲染引擎
 */
export interface Engine {
  /** 截图 */
  screenshot: (options: ScreenshotOptions) => Promise<ScreenshotResult>
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
  /** `null` 是「关掉缓存」，和「没配」不是一个意思，所以要分开判断 */
  if (config.cacheDir !== undefined) options.cacheDir = config.cacheDir || null
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

  return {
    screenshot: async (options) => {
      try {
        return await (await connect()).screenshot(options)
      } catch (error) {
        /** 连接层面的问题重连一次再试，渲染本身的报错会在第二次原样抛出 */
        client = null
        return await (await connect()).screenshot(options)
      }
    },
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
