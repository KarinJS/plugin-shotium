import fs from 'node:fs'
import path from 'node:path'
import { karin, logger } from 'node-karin'
import { basePath } from 'node-karin/root'
import pkg from '../../package.json'

/**
 * 热更新key
 */
export const HMR_KEY = 'karin-plugin-shotium-hmr'

/**
 * 本地文件的加载方式
 * - `file`: 直接以 `file://` 交给引擎，配合 `allowFileAccess` 读取同目录下的子资源
 * - `http`: 借用 karin 自身的 express 服务把本地文件转成 `http://` 再交给引擎
 * - `auto`: 默认走 `file`，当调用方传了 `headers` 时自动切到 `http`
 *   （引擎只对同源子资源发送自定义头，`file://` 文档没有同源可言）
 */
export type LocalAccess = 'auto' | 'file' | 'http'

/**
 * 插件配置
 */
export interface ShotiumConfig {
  /** 引擎运行方式：进程内 / 常驻守护进程 */
  mode: 'inprocess' | 'daemon'
  /** 本地文件加载方式 */
  localAccess: LocalAccess
  /** 默认截图类型 */
  type: 'png' | 'jpeg' | 'webp'
  /** 默认压缩质量 1-100，仅 jpeg/webp 生效 */
  quality: number
  /** 默认视窗 */
  viewport: {
    width: number
    height: number
  }
  /** 默认设备像素比 0.01-8 */
  scale: number
  /** 默认导航超时(ms) */
  timeout: number
  /** `multiPage: true` 时单张分片的最大高度(css px)，上限 32000 */
  autoMultiPageHeight: number
  /** HTTP 磁盘缓存目录，留空使用引擎默认目录，填 `off` 关闭缓存 */
  cacheDir: string
  /** HTTP 磁盘缓存上限(字节) */
  cacheMaxBytes: number
  /** 自定义 UA，留空使用引擎内置 */
  userAgent: string
  /** daemon 模式下的空闲退出时间(ms)，0 表示不退出 */
  idleTimeoutMs: number
  /** 打印每次截图的耗时统计 */
  logStats: boolean
}

/**
 * 默认配置
 */
export const defaultConfig: ShotiumConfig = {
  mode: 'inprocess',
  localAccess: 'auto',
  type: 'png',
  quality: 90,
  viewport: {
    width: 800,
    height: 600,
  },
  scale: 1,
  timeout: 30000,
  autoMultiPageHeight: 4000,
  cacheDir: '',
  cacheMaxBytes: 256 * 1024 * 1024,
  userAgent: '',
  idleTimeoutMs: 300000,
  logStats: true,
}

/** 插件名称 */
export const pluginName = pkg.name.replace(/\//g, '-')
/** 插件版本 */
export const pluginVersion = pkg.version
/** 配置文件路径 */
export const configPath = path.resolve(basePath, pluginName, 'config', 'config.json')

/**
 * 初始化配置
 */
const init = () => {
  if (!fs.existsSync(configPath)) {
    fs.mkdirSync(path.dirname(configPath), { recursive: true })
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2))
    logger.info(`[${pluginName}] 首次运行，已创建默认配置文件: ${configPath}`)
  }
}

/**
 * 获取配置
 * @returns 合并默认值之后的配置
 */
export const getConfig = (): ShotiumConfig => {
  try {
    const data = JSON.parse(fs.readFileSync(configPath, 'utf-8'))
    return {
      ...defaultConfig,
      ...data,
      viewport: { ...defaultConfig.viewport, ...(data?.viewport ?? {}) },
    }
  } catch (error) {
    logger.error(`[${pluginName}] 配置读取失败，已回退到默认配置: ${error instanceof Error ? error.message : String(error)}`)
    return { ...defaultConfig }
  }
}

/**
 * 保存配置
 * @param config 配置
 */
export const saveConfig = (config: ShotiumConfig) => {
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2))
  karin.emit(HMR_KEY, config)
}

export { pkg }

init()
