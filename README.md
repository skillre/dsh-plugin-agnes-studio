# @skillre/dsh-plugin-agnes-studio

> 状态：experimental · 实测 DSH `0.2.2-rc.1`（2026-11-11）

用 Agnes 的免费模型生成图片和视频，有两个入口：

- **侧栏看板**：在 DSH 左侧栏点「Agnes 工作室」，填提示词、调参数、出图出片，结果留在画廊里。
  点结果卡上的「打开原图」（或直接点缩略图）会在面板内放大查看：滚轮缩放、拖动平移、
  点图在适配与 2 倍之间切换，Esc 或点背景关闭。看板不弹新窗口，也不跳出应用。
- **会话内工具**：直接说「画一张…」「生成一段…视频」，模型调用 `agnes_image` / `agnes_video`，
  图片作为真正的 DSH 图片块出现在对话里。

[English](README.en.md)

## 它能做什么

| 能力 | 模型 | 参数 |
|---|---|---|
| 文生图 / 图生图 / 多图合成 | `agnes-image-2.5-flash`（默认）、`2.1-flash`、`2.0-flash` | 分辨率档 `1K`/`2K`/`3K`/`4K`，比例 8 种，最多 8 张参考图 |
| 文生视频 / 首尾帧 / 参考素材 | `agnes-video-2.5`（默认）、`agnes-video-2.5-flash` | 720P–2K（Flash 固定 720P），比例 6 种，4–12 秒，可选 seed，首帧/尾帧/参考图/参考音频/参考视频 |

参数不是自由填写的：看板的下拉项由模型能力表生成，Host 在发请求前按同一张表校验。
选 `agnes-video-2.5-flash` 时分辨率只剩 720P，因为上游对该模型只接受 720P —— 这样 UI 永远不会
给出一个上游会以 HTTP 400 拒绝的值。

## 安装

**由用户**在 DSH Desktop Client 或 Web UI 的 **Plugins / 插件管理** 里选择来源并确认安装。
发布后输入 npm 包名（如 `@skillre/dsh-plugin-agnes-studio@0.1.0`）；未发布时可用已构建
`.tgz` 的绝对路径，但需先确认目标客户端接受该来源。

安装后到 **Plugins → 本插件 → 配置** 里确认 `enableTools` 为开（默认开），左侧栏就会出现入口。

### 配置 API Key

插件**不把密钥写进配置文件**。按以下顺序解析，每次调用都重新读取，所以换 key 不需要重启：

1. DSH 凭据服务里名为 `AGNES_API_KEY` 的记录（推荐）；
2. 环境变量 `AGNES_API_KEY`；
3. 都没有 → 看板显示「还没有配置 API Key」并禁用生成按钮，会话里的工具返回 `not-configured`。

在 <https://platform.agnes-ai.com> 创建免费 key（无需绑卡）。密钥只在 Host 侧使用，
不会发送到浏览器，也不会写进生成记录。

## 配置项

全部可选，在插件行的 `config` 里覆盖：

| 键 | 默认 | 说明 |
|---|---|---|
| `baseUrl` | `https://apihub.agnes-ai.com/v1` | Agnes API 根地址，不带结尾斜杠 |
| `credentialRef` | `AGNES_API_KEY` | 凭据服务里的记录名 |
| `apiKeyEnv` | `AGNES_API_KEY` | 凭据为空时回退的环境变量名 |
| `dataDir` | `''` → `$DSH_HOME/agnes-studio` | 生成记录索引与媒体文件目录（插件独占）。留空时跟随 DSH home，避免隔离 profile 写进用户真实目录 |
| `enableTools` | `true` | 是否注册 `agnes_image` / `agnes_video` 工具 |
| `historyLimit` | `200` | 保留多少条记录；超出时最旧的连同文件一起删除 |
| `imageTimeoutMs` | `360000` | 生图超时（上游建议 60–360 秒） |
| `videoTimeoutMs` | `900000` | 视频任务总超时，含排队 |
| `pollIntervalMs` | `2000` | 视频任务轮询间隔 |

## 权限与副作用

- **网络**：只访问 `baseUrl`（默认 `apihub.agnes-ai.com`）以及它返回的媒体地址。
  第三方 CDN 的下载**不带** API Key。
- **文件**：只写 `dataDir`（默认 `$DSH_HOME/agnes-studio`），一个 `index.json` 加 `media/` 下的媒体文件。
  文件名是随机 UUID；读取时再校验一次 id 形状，路径穿越不可达。
- **密钥**：只经凭据服务或环境变量读取；不写日志、不进生成记录、不发给浏览器。
- **浏览器**：看板通过 DSH Connection 的 `/api` 路由通信，走同一套 Host/Origin 与登录态校验；
  生成的媒体也经同一道栅栏提供，不是公开可读。

## 数据与清理

生成记录在 `$DSH_HOME/agnes-studio`（通常是 `~/.dsh/agnes-studio`）：

```sh
# 删除全部生成记录与文件（等价于看板的「清空全部」）
rm -rf ~/.dsh/agnes-studio
```

看板里单条删除、清空全部都会同时删掉索引项和磁盘文件。

`dataDir` 留空（默认）时跟随 `$DSH_HOME`，只有在 `DSH_HOME` 未设置时才回退到 `~/.dsh` ——
这样在隔离或自定义 home 的 profile 里，数据不会落进用户真实安装目录。

## 卸载与回滚

见 [UNINSTALL](UNINSTALL.md)。卸载插件不会自动删除 `~/.dsh/agnes-studio`；
如不再需要，按上面的命令手动删除。

## 已知限制

- 视频是**异步**任务：提交后 Host 轮询上游直到完成。队列满时上游返回 HTTP 503
  `video_queue_full`，看板会标为「可重试」而不是报成参数错误。
- 参考素材必须是**公网可访问**的 HTTPS 地址或 `data:` URI。localhost、内网地址、明文 HTTP
  在发请求前就被拒绝 —— 上游自己去取素材，这类地址只会延迟失败。
- `agnes-video-2.5-flash` 不支持参考视频，且最多 5 张参考图（`2.5` 是 8 张）。
- 生成记录是**本地**的，不跨设备同步；`historyLimit` 之外的最旧记录会被删除。
- 看板一次只跑一个任务（避免重复提交造成重复计费与排队加深）。
- 图片查看器只在**面板内**放大，不会打开系统图片查看器或新窗口：生成图是本地存储、
  靠会话鉴权访问的，交给外部程序既会 401 也会绕开 DSH 的窗口策略。
- 同一 `dataDir` 只应由一个插件实例使用：索引写入在单个 handle 内串行化，两个实例指向同一目录
  仍可能互相覆盖。
- 图片以 DSH 附件形式进入对话；视频以同源 URL 返回，在对话里给出可打开的位置，
  不是视频块。
- Agnes 的免费额度、模型清单与参数上限由上游随时调整；本插件按 2026-11-11 的实测契约实现，
  上游新增能力需要更新插件。

## 验证记录

- 离线测试 137 项：参数校验、响应解析、错误映射、存储并发与淘汰、路由栅栏、媒体路径形状、
  Range 请求、schema 契约、工具参数映射、看板渲染、图片查看器交互，以及**打包后的 client
  bundle**（走真实 loader 信封加载并渲染两个注册面）。
- 打包 tarball 装入一次性隔离 profile：`--dump-config` 合成、有界真实启动、经认证的
  `/api` 路由调用、真实生图并下载字节、重启后记录与文件仍在、删除后文件消失。
- 真实 headless Chrome 驱动 DSH Web 应用：侧栏入口、看板渲染、两个能力页的模型派生控件、
  Flash 收窄分辨率、画廊卡片、图片查看器（覆盖整个视口、缩放改变实际布局、Esc/背景关闭、
  点图不关闭），共 21 项。证据见 `docs/evidence/`。

## 开发

```sh
npm install
npm run check     # preview + typecheck + 137 项测试 + publint + pack
npm pack
```

隔离验证（**只用自己拥有的、可丢弃的非 Desktop profile**）：

```sh
AGNES_API_KEY=... node scripts/verify-isolated.mjs ./skillre-dsh-plugin-agnes-studio-0.1.0.tgz
```

脚本自己创建临时 DSH home、装包、启动、验证，并在 `finally` 里停进程、删目录、核对清理完成。

## Bundle

- npm：`@skillre/dsh-plugin-agnes-studio`
- GitHub：`skillre/dsh-plugin-agnes-studio`
- Cordis row / plugin name：`skillre-agnes-studio`
- `package.json#dsh.bundle.patch` → `cordis.patch.yml`

## 显示元数据

`locale/en.json`、`locale/zh.json` 提供卡片标题与描述，`icon.svg` 是图标。
三者都随包发布（`files` 覆盖，`exports` 声明 `"./locale/*.json"`）。
