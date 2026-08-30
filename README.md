# @karinjs/plugin-shotium

karin 的 [shotium](https://github.com/sj817/shotium) 截图渲染插件。

shotium 是一个被裁剪过的 chromium：只留下 Blink 布局、Skia CPU 光栅化、字体与图片解码，以及 chromium 的网络栈，
V8、content 框架、GPU 进程、DevTools 协议全部拿掉了。
它以 Node-API 的形式跑在 node 进程里，没有浏览器进程，也没有 CDP 往返。

对 karin 来说，这意味着渲染模板图这件事不再需要装一个 100+ MB 的浏览器。
代价是页面里的 JavaScript 不会执行——模板必须是服务端渲染好的静态 HTML。

## 安装

```bash
pnpm add @karinjs/plugin-shotium -w
```

装好重启 karin 即可，插件会自己把渲染器注册进 karin 的渲染器列表。

## 它做了什么

karin 的渲染器就是一个函数：收下 `Options`，还回 base64。
这个插件把 karin/puppeteer 那一套参数翻译成 shotium 的参数，再把结果翻译回去。

| karin | shotium | 说明 |
| --- | --- | --- |
| `file` | `file` | 本地路径按配置转成 `file://` 或桥接 http 地址 |
| `data` | — | 交给 karin 的 `renderTpl` 先跑 art-template |
| `selector` | `selector` | 引擎内部用 `Document::querySelector` 解析，不注入脚本 |
| `fullPage` | `fullPage` | 与 `selector` 互斥，`fullPage` 优先 |
| `setViewport.width/height` | `viewport` | |
| `setViewport.deviceScaleFactor` | `scale` | |
| `type` / `quality` | `type` / `quality` | png 不带 `quality` |
| `omitBackground` | `omitBackground` | jpeg 没有 alpha，会被忽略 |
| `clip` | `clip` | `clip.scale` 无对应项 |
| `pageGotoParams.waitUntil` | `pageGotoParams.waitUntil` | `networkidle0/2` 统一归到 `networkidle` |
| `pageGotoParams.timeout` | `pageGotoParams.timeout` | `0`(不超时) 回退到引擎默认值 |
| `headers` | `headers` | 只对同源子资源生效，见下 |
| `multiPage` | — | 插件侧对同一张图做无损切割 |
| `waitForSelector` 等 | — | 引擎没有 JS 运行时，忽略并提示一次 |

### 分片渲染

`multiPage` 在 puppeteer 那边是「改视窗高度重截几次」，
这里换成了「截一次，再把 PNG 按行切开」：不重新布局，也就不会出现分片之间样式对不上的情况。
切割直接在 zlib 层面做，不依赖任何图像库。

因为切割器只认 PNG，`multiPage` 配上 jpeg/webp 时会自动切到 png，并在日志里提示一次。

切割要把整张图重压一遍，这一步在大图上并不便宜。1440x2541 那张图上，
同一份像素 deflate level 9 要 1.3s、level 6 要 0.48s、level 3 只要 0.19s，
而体积差别只有个位数百分比，所以默认用 level 3，可以通过 `sliceCompression` 调。

### 本地文件怎么交给引擎

`localAccess` 有三档：

- `file`（默认路径）：`file://` 直接打开，同时打开引擎的 `allowFileAccess`，
  模板里 `file://` 形式的图片、字体照常能读到。
- `http`：借用 **karin 自己的 express 服务**，把本地文件挂在一个带随机 token 的路径下转成 `http://` 再截图。
  插件不另开端口。
  http 文档下 chromium 会拒绝加载 `file://` 子资源，所以这条路径上 HTML/CSS 里的 `file://` 引用会被一并改写成桥接地址。
- `auto`（默认）：平时走 `file`，只有调用方传了 `headers` 时才切到 `http`——
  引擎只对同源子资源发送自定义头，`file://` 文档没有同源可言，headers 会被整个丢掉。

桥接路径里带一段进程级随机 token，并且只放行渲染会用到的后缀，
避免 karin 监听在 `0.0.0.0` 时把工作目录直接暴露出去。

## 配置

首次运行会在 `@karinjs/@karinjs-plugin-shotium/config/config.json` 生成默认配置，也可以在 WebUI 里改。

| 字段 | 默认值 | 说明 |
| --- | --- | --- |
| `mode` | `inprocess` | `inprocess` 进程内 / `daemon` 常驻守护进程 |
| `localAccess` | `auto` | 见上 |
| `type` | `png` | 调用方没指定时的截图格式 |
| `quality` | `90` | jpeg / webp 的压缩质量 |
| `viewport` | `800x600` | 默认视窗 |
| `scale` | `1` | 默认设备像素比 |
| `timeout` | `30000` | 默认导航超时 |
| `autoMultiPageHeight` | `4000` | `multiPage: true` 时每片的高度 |
| `sliceCompression` | `3` | 分片重新编码的 deflate 级别 0-9 |
| `cacheDir` | `''` | HTTP 磁盘缓存目录，留空用引擎默认，填 `off` 关闭 |
| `cacheMaxBytes` | `256MB` | 缓存上限 |
| `userAgent` | `''` | 留空使用引擎内置 |
| `idleTimeoutMs` | `300000` | 守护进程空闲退出时间 |
| `logStats` | `true` | 日志里带上引擎耗时统计 |

改完配置会热重建引擎，不需要重启 karin。

## 性能与实测

性能结论以 Shotium 主仓库的[六平台基准报告](https://sj817.github.io/shotium/)为准。
README 不再混用不同机器、版本和页面的绝对耗时，也不跨平台排名。

### 标准基准

下面摘录 Shotium 0.3.3 的 `linux-x64` 合格结果。三者在同一原生 runner、同一静态页面、
PNG、1280×720、scale 1、`waitUntil: load` 条件下测试；表内为 p50，越低越好。

| 场景 | Shotium | Puppeteer Shell | Puppeteer Chrome |
| --- | ---: | ---: | ---: |
| 冷启动 | 53 ms | 282 ms（5.32×） | 471 ms（8.89×） |
| 启动稳定后的首张 | 21.028 ms | 104.061 ms（4.95×） | 114.146 ms（5.43×） |
| 预热截图 | 24.905 ms | 131.601 ms（5.28×） | 157.438 ms（6.32×） |
| 启动—截图—关闭循环 | 53.989 ms | 289.344 ms（5.36×） | 565.139 ms（10.47×） |

数据来源：[Shotium 0.3.3 基准报告](https://github.com/sj817/shotium/blob/main/benchmark-results/v0.3.3/20260830T000525Z-gh33274826755-a1/report.zh-CN.md)。
该次六平台聚合结果标记为“不完整”，所以上表只引用其中状态为“通过”、允许排名的
`linux-x64` 同平台数据，不推测缺失结果。

### KKK 帮助卡片兼容性实测

2026-08-30 使用 `karin-plugin-kkk` 2.42.2、`@karinjs/plugin-shotium` 0.1.0 和
Shotium 0.3.3，在 Windows x64 对实际 SSR 帮助卡片进行了明暗主题冒烟测试：

| 主题 | 尺寸 | PNG 大小 | 插件总耗时 | 引擎耗时 |
| --- | ---: | ---: | ---: | ---: |
| 亮色 | 1440×2673 | 5.58 MB | 800 ms | 781.2 ms |
| 暗色 | 1440×2673 | 6.01 MB | 746 ms | 732.5 ms |

两张卡片的布局、中文、背景和主题均正确。此处只有各一次样本，而且隔离测试没有启动
KKK 的 3780 字体服务，20 个 HarmonyOS 字体请求回退到系统字体，因此它只用于兼容性证明，
不参与上面的性能排名。

这类大卡片会同时承担数 MB CSS 解析和大尺寸 PNG 编码成本；Shotium 主要节省的是冷启动、
常驻内存与浏览器进程/CDP 往返开销。页面越小、调用越频繁，固定开销差异越明显。

需要更快的话，按收益排序：

1. 输出换成 `jpeg` 或 `webp`；代价是 jpeg 没有 alpha 通道，`omitBackground` 会失效。
2. 模板侧把 CSS purge 掉，别把整份 tailwind 内联进每张图。
3. 图别做那么大——同一份内容宽度减半，像素少四分之三。

## 已知限制

- **页面里的 JavaScript 不会执行。** 模板必须是 SSR 好的静态 HTML。
  用 Vue/React 组件路径当模板的 `file_type`（`vue3`、`vueString`、`react`）会直接报错。
- `data:` 开头的地址不能当作**主文档**（子资源里的 data URI 正常）。
  插件会把 `file_type: 'htmlString'` 的字符串先落盘再截。
- 没有 `waitForSelector` / `waitForFunction` / `waitForRequest` / `waitForResponse`。
- 抗锯齿是确定性的灰阶抗锯齿，和 puppeteer 的输出会有极细微的差别。

## License

MIT
