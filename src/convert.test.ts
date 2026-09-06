import { describe, it, expect } from 'vitest'
import { toWaitUntil, toScreenshotOptions, pickUnsupported, toSliceHeight, toTilePath, MAX_TILE_HEIGHT } from './convert'
import { defaultConfig } from './config/index'

describe('toWaitUntil', () => {
  it('把 puppeteer 的 networkidle0/2 归到 networkidle', () => {
    expect(toWaitUntil('networkidle0')).toBe('networkidle')
    expect(toWaitUntil('networkidle2')).toBe('networkidle')
    expect(toWaitUntil(['load', 'networkidle2'])).toBe('networkidle')
  })

  it('其余情况都算 load', () => {
    expect(toWaitUntil('load')).toBe('load')
    expect(toWaitUntil('domcontentloaded')).toBe('load')
    expect(toWaitUntil(undefined)).toBeUndefined()
  })
})

describe('toScreenshotOptions', () => {
  it('png 不带 quality', () => {
    const result = toScreenshotOptions({ file: 'a.html', type: 'png', quality: 50 } as never, defaultConfig)
    expect(result.type).toBe('png')
    expect(result.quality).toBeUndefined()
  })

  it('jpeg 带上 quality，并且丢掉 omitBackground', () => {
    const result = toScreenshotOptions(
      { file: 'a.html', type: 'jpeg', quality: 60, omitBackground: true } as never,
      defaultConfig
    )
    expect(result.quality).toBe(60)
    expect(result.omitBackground).toBeUndefined()
  })

  it('fullPage 优先于 selector', () => {
    const result = toScreenshotOptions(
      { file: 'a.html', fullPage: true, selector: '#container' } as never,
      defaultConfig
    )
    expect(result.fullPage).toBe(true)
    expect(result.selector).toBeUndefined()
  })

  it('fullPage 为 false 时用 selector', () => {
    const result = toScreenshotOptions(
      { file: 'a.html', fullPage: false, selector: '#container' } as never,
      defaultConfig
    )
    expect(result.selector).toBe('#container')
  })

  it('setViewport 拆成 viewport 与 scale', () => {
    const result = toScreenshotOptions(
      { file: 'a.html', setViewport: { width: 1200, height: 900, deviceScaleFactor: 2 } } as never,
      defaultConfig
    )
    expect(result.viewport).toEqual({ width: 1200, height: 900 })
    expect(result.scale).toBe(2)
  })

  it('timeout 为 0 时不透传，交给引擎用默认值', () => {
    const result = toScreenshotOptions(
      { file: 'a.html', pageGotoParams: { waitUntil: 'load', timeout: 0 } } as never,
      defaultConfig
    )
    expect(result.pageGotoParams).toEqual({ waitUntil: 'load' })
  })
})

describe('pickUnsupported', () => {
  it('挑出引擎做不到的等待类选项', () => {
    expect(pickUnsupported({ file: 'a.html', waitForSelector: '#a' } as never)).toEqual(['waitForSelector'])
    expect(pickUnsupported({ file: 'a.html', waitForFunction: [] } as never)).toEqual([])
    expect(pickUnsupported({ file: 'a.html' } as never)).toEqual([])
  })
})

describe('toSliceHeight', () => {
  it('true 走默认高度，数字按数字来，其余不分片', () => {
    expect(toSliceHeight(true, 4000)).toBe(4000)
    expect(toSliceHeight(1200, 4000)).toBe(1200)
    expect(toSliceHeight(false, 4000)).toBe(0)
    expect(toSliceHeight(undefined, 4000)).toBe(0)
    expect(toSliceHeight(0, 4000)).toBe(0)
    expect(toSliceHeight(-100, 4000)).toBe(0)
  })

  it('夹到引擎能接受的整数区间，而不是让引擎拒掉整个请求', () => {
    expect(toSliceHeight(true, 99999)).toBe(MAX_TILE_HEIGHT)
    expect(toSliceHeight(50000, 4000)).toBe(MAX_TILE_HEIGHT)
    expect(toSliceHeight(1200.6, 4000)).toBe(1201)
    expect(toSliceHeight(0.4, 4000)).toBe(1)
  })
})

describe('toTilePath', () => {
  it('路径里写了 {n} 就替换成片号', () => {
    expect(toTilePath('out/page-{n}.png', 2, 3)).toBe('out/page-2.png')
    expect(toTilePath('out/{n}/{n}.png', 1, 3)).toBe('out/1/1.png')
  })

  it('没写 {n} 就把片号插在扩展名前面', () => {
    expect(toTilePath('out/page.png', 1, 3)).toBe('out/page-1.png')
    expect(toTilePath('out/page.png', 3, 3)).toBe('out/page-3.png')
    expect(toTilePath('out/page', 2, 3)).toBe('out/page-2')
  })

  it('只有一片时原样存，退化成不分片的行为', () => {
    expect(toTilePath('out/page.png', 1, 1)).toBe('out/page.png')
  })
})
