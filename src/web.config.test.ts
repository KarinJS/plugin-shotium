import fs from 'node:fs'
import { describe, it, expect, beforeEach } from 'vitest'
import webConfig from './web.config'
import { getConfig, configPath, defaultConfig } from './config/index'

describe('web.config', () => {
  beforeEach(() => {
    fs.writeFileSync(configPath, JSON.stringify(defaultConfig, null, 2))
  })

  it('info 里带上包名与版本', () => {
    expect(webConfig.info.id).toBe('@karinjs/plugin-shotium')
    expect(typeof webConfig.info.version).toBe('string')
  })

  it('components 能正常构造出一组组件', () => {
    expect(Array.isArray(webConfig.components())).toBe(true)
  })

  it('save 把扁平表单写回嵌套配置', () => {
    const result = webConfig.save({
      mode: 'daemon',
      localAccess: 'http',
      type: 'jpeg',
      quality: '70',
      viewportWidth: '1200',
      viewportHeight: '900',
      scale: '2',
      timeout: '10000',
      autoMultiPageHeight: '3000',
      cacheDir: '',
      cacheMaxBytes: '1024',
      userAgent: 'ua',
      idleTimeoutMs: '0',
      logStats: false,
    })

    expect(result.success).toBe(true)
    const saved = getConfig()
    expect(saved.mode).toBe('daemon')
    expect(saved.localAccess).toBe('http')
    expect(saved.viewport).toEqual({ width: 1200, height: 900 })
    expect(saved.scale).toBe(2)
    expect(saved.cacheDir).toBe('')
    expect(saved.autoMultiPageHeight).toBe(3000)
    expect(saved.logStats).toBe(false)
  })

  it('填 off 表示关闭缓存，留空表示用引擎默认目录', () => {
    webConfig.save({ ...defaultConfig, cacheDir: 'off' } as never)
    expect(getConfig().cacheDir).toBe('off')
    webConfig.save({ ...defaultConfig, cacheDir: '  ' } as never)
    expect(getConfig().cacheDir).toBe('')
  })
})
