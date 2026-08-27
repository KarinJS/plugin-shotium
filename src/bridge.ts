import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { app, logger } from 'node-karin'
import { pluginName } from './config/index'

import type { Request, Response } from 'express'

/**
 * 允许经由桥接暴露的后缀
 *
 * karin 的 express 服务大多监听在 `0.0.0.0`，所以这里不做「整个工作目录直出」的事情：
 * 路径里带一段进程级随机 token，再叠加后缀白名单，
 * 保证只有本次进程里的渲染请求能读到、且只能读到渲染要用的静态资源。
 */
const ALLOWED_EXT: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.bmp': 'image/bmp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.eot': 'application/vnd.ms-fontobject',
}

/** 需要改写内部 `file://` 引用的类型 */
const REWRITE_EXT = new Set(['.html', '.htm', '.css', '.svg'])

/** 进程级随机 token */
const token = crypto.randomBytes(16).toString('hex')
/** 挂载前缀 */
const mountPath = `/shotium/${token}/fs`

let mounted = false

/**
 * 把绝对路径转成桥接 URL 的 path 部分
 *
 * `D:\a\b.png` -> `/shotium/<token>/fs/D:/a/b.png`
 * `/a/b.png`   -> `/shotium/<token>/fs/a/b.png`
 *
 * 保留目录层级是刻意的：文档里的相对引用（`./x.png`）能被浏览器按同样的规则解析回来，
 * 不需要额外注入 `<base>`。
 *
 * @param file 绝对路径
 * @returns URL path
 */
const toUrlPath = (file: string): string => {
  const posix = path.resolve(file).split(path.sep).join('/').replace(/^\/+/, '')
  return `${mountPath}/${posix.split('/').map(encodeURIComponent).join('/')}`
}

/**
 * 把桥接 URL 的 path 还原成绝对路径
 * @param urlPath 挂载点之后的路径
 * @returns 绝对路径
 */
const toFilePath = (urlPath: string): string => {
  const raw = decodeURIComponent(urlPath).replace(/^\/+/, '')
  return /^[a-zA-Z]:/.test(raw) ? raw : `/${raw}`
}

/**
 * 改写文本里的 `file://` 引用
 *
 * http 文档下 chromium 会直接拒绝加载 `file://` 子资源
 * （`Not allowed to load local resource`），所以走 http 模式时必须先把它们换成桥接地址。
 * 模板里常见的 data URI 和 http(s) 引用保持原样。
 *
 * @param text 文本内容
 * @returns 改写后的文本
 */
const rewriteFileUrls = (text: string): string => {
  return text.replace(/file:\/\/\/?[^"')\s>]+/g, (match) => {
    try {
      return toUrlPath(fileURLToPath(new URL(match)))
    } catch {
      return match
    }
  })
}

/**
 * 桥接请求处理
 */
const handler = (req: Request, res: Response) => {
  const file = path.normalize(toFilePath(req.path))
  const ext = path.extname(file).toLowerCase()

  if (file.includes('..')) {
    res.status(403).end('forbidden')
    return
  }

  const type = ALLOWED_EXT[ext]
  if (!type) {
    res.status(415).end('unsupported file type')
    return
  }

  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
    res.status(404).end('not found')
    return
  }

  res.setHeader('Content-Type', type)

  if (REWRITE_EXT.has(ext)) {
    res.end(rewriteFileUrls(fs.readFileSync(file, 'utf-8')))
    return
  }

  fs.createReadStream(file).pipe(res)
}

/**
 * 挂载桥接路由到 karin 自身的 express 服务
 *
 * 插件不自己起端口：karin 已经有一个 http server，
 * 复用它既省掉一个端口，也让「渲染器能不能访问到资源」这件事和 karin 的网络配置保持一致。
 */
export const mountBridge = () => {
  if (mounted) return
  app.use(mountPath, handler)
  mounted = true
  logger.debug(`[${pluginName}] 本地资源桥接已挂载: ${mountPath}`)
}

/**
 * 桥接是否可用
 * @returns karin 的 http 服务开着才可用
 */
export const isBridgeAvailable = (): boolean => {
  return process.env.HTTP_ENABLE !== 'false' && !!process.env.HTTP_PORT
}

/**
 * 把本地文件转成引擎可以直接访问的 http 地址
 * @param file 绝对路径
 * @returns http 地址
 */
export const toBridgeUrl = (file: string): string => {
  mountBridge()
  const port = process.env.HTTP_PORT || '7777'
  return `http://127.0.0.1:${port}${toUrlPath(file)}`
}

/**
 * 把本地文件转成 `file://` 地址
 * @param file 绝对路径
 * @returns file 地址
 */
export const toFileUrl = (file: string): string => pathToFileURL(path.resolve(file)).href
