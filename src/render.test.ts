/**
 * 渲染器本身的端到端用例：真的把引擎拉起来渲染一次
 *
 * 其余用例都是纯映射，这一个是唯一一条覆盖「参数进去、图片出来」的路径，
 * 需要本机装得上 `@pixel.js/shotium` 的平台包。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, it, expect, vi, afterAll } from 'vitest'
import { registerRender, renderTpl } from 'node-karin'

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'shotium-render-'))
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }))
const html = path.join(dir, 'tall.html')
fs.writeFileSync(
  html,
  `<!doctype html><meta charset="utf-8"><style>body{margin:0}#container{width:600px}
   .row{height:100px}</style><div id="container">${Array.from({ length: 95 }, (_, i) =>
    `<div class="row" style="background:hsl(${i * 3},70%,85%)">row ${i}</div>`).join('')}</div>`
)

vi.mocked(renderTpl).mockImplementation((o: never) => o)

describe('渲染器', () => {
  it('分片走 tiles，整张走 screenshot', async () => {
    await import('./index')
    const render = vi.mocked(registerRender).mock.calls[0][1] as (o: never) => Promise<never>

    const one = await render({ file: html, selector: '#container', type: 'png' } as never)
    expect(typeof one).toBe('string')

    const savePath = path.join(dir, 'out.jpeg')
    const many = await render({
      file: html,
      selector: '#container',
      type: 'jpeg',
      quality: 80,
      multiPage: 4000,
      path: savePath,
    } as never) as unknown as string[]

    expect(Array.isArray(many)).toBe(true)
    expect(many).toHaveLength(3)
    /** 每一片都是真的 jpeg，分片不再被强制转成 png */
    for (const item of many) {
      expect(Buffer.from(item, 'base64').subarray(0, 2)).toEqual(Buffer.from([0xff, 0xd8]))
    }
    /** path 按片编号落盘 */
    expect(fs.existsSync(path.join(dir, 'out-1.jpeg'))).toBe(true)
    expect(fs.existsSync(path.join(dir, 'out-3.jpeg'))).toBe(true)
    expect(fs.existsSync(savePath)).toBe(false)
  }, 60000)
})
