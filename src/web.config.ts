import { components } from 'node-karin'
import { getConfig, saveConfig, defaultConfig, pkg } from './config/index'

import type { ComponentConfig, GetConfigResponse } from 'node-karin'
import type { ShotiumConfig } from './config/index'

/** WebUI 提交上来的表单 */
type FormValue = Record<string, unknown>

/**
 * 取数字，取不到就用默认值
 * @param value 表单值
 * @param fallback 默认值
 * @returns 数字
 */
const toNumber = (value: unknown, fallback: number): number => {
  const num = Number(value)
  return Number.isFinite(num) ? num : fallback
}

const webConfig: {
  info: GetConfigResponse['info']
  components: () => ComponentConfig[]
  save: (config: FormValue) => { success: boolean, message: string }
} = {
  info: {
    id: pkg.name,
    name: 'shotium 渲染器',
    version: pkg.version,
    description: pkg.description,
    author: [
      {
        name: 'sj817',
        home: 'https://github.com/sj817',
        avatar: 'https://github.com/sj817.png',
      },
    ],
    icon: {
      name: 'camera',
      size: 24,
      color: '#0969da',
    },
  },
  components: () => {
    const config = getConfig()
    return [
      components.radio.group('mode', {
        label: '引擎运行方式',
        orientation: 'horizontal',
        description: '进程内最省事；守护进程可以让 karin 重启时不用重新付冷启动的钱',
        defaultValue: config.mode,
        radio: [
          components.radio.create('inprocess', { label: '进程内', value: 'inprocess' }),
          components.radio.create('daemon', { label: '守护进程', value: 'daemon' }),
        ],
      }),
      components.radio.group('localAccess', {
        label: '本地文件加载方式',
        orientation: 'horizontal',
        description:
          'auto: 默认 file，带自定义请求头时自动走 http；' +
          'file: 直接 file:// 打开；' +
          'http: 借用 karin 自身的 http 服务转成 http:// 再截图',
        defaultValue: config.localAccess,
        radio: [
          components.radio.create('auto', { label: 'auto', value: 'auto' }),
          components.radio.create('file', { label: 'file', value: 'file' }),
          components.radio.create('http', { label: 'http', value: 'http' }),
        ],
      }),
      components.divider.create('divider0'),
      components.radio.group('type', {
        label: '默认截图格式',
        orientation: 'horizontal',
        description: '调用方没有指定格式时使用',
        defaultValue: config.type,
        radio: [
          components.radio.create('png', { label: 'png', value: 'png' }),
          components.radio.create('jpeg', { label: 'jpeg', value: 'jpeg' }),
          components.radio.create('webp', { label: 'webp', value: 'webp' }),
        ],
      }),
      components.input.number('quality', {
        label: '默认压缩质量',
        description: '1-100，只对 jpeg / webp 生效',
        defaultValue: String(config.quality),
      }),
      components.input.number('viewportWidth', {
        label: '默认视窗宽度',
        description: '单位 css 像素',
        defaultValue: String(config.viewport.width),
      }),
      components.input.number('viewportHeight', {
        label: '默认视窗高度',
        description: '单位 css 像素',
        defaultValue: String(config.viewport.height),
      }),
      components.input.number('scale', {
        label: '默认设备像素比',
        description: '0.01-8，相当于 puppeteer 的 deviceScaleFactor',
        defaultValue: String(config.scale),
      }),
      components.input.number('timeout', {
        label: '默认导航超时(ms)',
        defaultValue: String(config.timeout),
      }),
      components.input.number('autoMultiPageHeight', {
        label: '自动分片高度',
        description: '调用方传 multiPage: true 时，每片的高度(css 像素)',
        defaultValue: String(config.autoMultiPageHeight),
      }),
      components.input.number('sliceCompression', {
        label: '分片重新编码的压缩级别',
        description: '0-9。分片要把整张图拆开重压一遍，级别越低越快、体积越大，3 是折中值',
        defaultValue: String(config.sliceCompression),
      }),
      components.divider.create('divider1'),
      components.input.string('cacheDir', {
        label: 'HTTP 缓存目录',
        description: '留空使用引擎默认目录；填 off 表示关闭缓存',
        defaultValue: config.cacheDir,
        isRequired: false,
      }),
      components.input.number('cacheMaxBytes', {
        label: 'HTTP 缓存上限(字节)',
        defaultValue: String(config.cacheMaxBytes),
      }),
      components.input.string('userAgent', {
        label: '自定义 UA',
        description: '留空使用引擎内置 UA',
        defaultValue: config.userAgent,
        isRequired: false,
      }),
      components.input.number('idleTimeoutMs', {
        label: '守护进程空闲退出(ms)',
        description: '0 表示不退出，仅守护进程模式生效',
        defaultValue: String(config.idleTimeoutMs),
      }),
      components.switch.create('logStats', {
        label: '打印引擎耗时统计',
        description: '每次截图在日志里带上请求数与引擎耗时',
        defaultSelected: config.logStats,
        color: 'success',
      }),
    ]
  },
  save: (form) => {
    try {
      const current = getConfig()
      const cacheDir = String(form.cacheDir ?? '').trim()

      const next: ShotiumConfig = {
        mode: (form.mode as ShotiumConfig['mode']) || current.mode,
        localAccess: (form.localAccess as ShotiumConfig['localAccess']) || current.localAccess,
        type: (form.type as ShotiumConfig['type']) || current.type,
        quality: toNumber(form.quality, current.quality),
        viewport: {
          width: toNumber(form.viewportWidth, current.viewport.width),
          height: toNumber(form.viewportHeight, current.viewport.height),
        },
        scale: toNumber(form.scale, current.scale),
        timeout: toNumber(form.timeout, current.timeout),
        autoMultiPageHeight: toNumber(form.autoMultiPageHeight, defaultConfig.autoMultiPageHeight),
        sliceCompression: Math.min(9, Math.max(0, toNumber(form.sliceCompression, defaultConfig.sliceCompression))),
        cacheDir,
        cacheMaxBytes: toNumber(form.cacheMaxBytes, current.cacheMaxBytes),
        userAgent: String(form.userAgent ?? ''),
        idleTimeoutMs: toNumber(form.idleTimeoutMs, current.idleTimeoutMs),
        logStats: form.logStats !== false,
      }

      saveConfig(next)
      return { success: true, message: '保存成功' }
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      }
    }
  },
}

export default webConfig
