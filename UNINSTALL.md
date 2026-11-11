# 卸载与回滚 · Uninstall and rollback

## 卸载

在 DSH Desktop Client 或 Web UI 的 **Plugins / 插件管理** 里找到本插件，选择卸载（Uninstall），
然后确认 bundle 已从 profile 中移除。

**不要**用命令行或直接编辑 profile 的 `package.json` / `cordis.patch.yml` 来卸载：那会绕过 DSH 的
状态管理，留下不一致的依赖与选择记录。

卸载会移除：

- Cordis 行 `skillre-agnes-studio`（Host 侧的两个 `/api` 路由与两个模型工具随 Fiber 一起释放）；
- 左侧栏的「Agnes 工作室」入口与中心面板；
- npm 包 `@skillre/dsh-plugin-agnes-studio` 及其依赖。

卸载**不会**自动删除生成数据。如果不再需要，手动删除：

```sh
rm -rf "$DSH_HOME/agnes-studio"     # 通常等价于 ~/.dsh/agnes-studio
```

## 回滚到上一个版本

从 npm 安装的插件在详情页有 **「版本 / Versions」** 区块，可以查看并选择旧版本就地重装。
就地更新失败时 DSH 会自动回装原版本。

如果详情页没有版本区块，说明当前安装不是从 registry spec 安装的（例如 tarball 或 Git URL），
这类安装无法就地更新，只能卸载后重装。

## 数据兼容性

`$DSH_HOME/agnes-studio/index.json` 带 `version: 1` 字段。降级到更早的插件版本时，如果该版本不认识
更高版本的记录，索引会被当作空索引读取 —— 媒体文件仍在磁盘上，但不会出现在画廊里。
这种情况下请删除该目录重新开始，或重新安装较新的版本。

## 故障排查

| 现象 | 处理 |
|---|---|
| 侧栏没有入口 | 确认 bundle 已启用；刷新页面（Client 侧代码需要重新加载） |
| 面板提示「还没有配置 API Key」 | 在 DSH 凭据里设置 `AGNES_API_KEY`，或设置同名环境变量后重试 |
| 生成报「队列已满」 | Agnes 视频队列暂时排满，稍后重试即可（面板会给出重试按钮） |
| 生成报「参考素材必须是公网地址」 | 上游自己去取素材，localhost/内网/HTTP 地址不可用；换成公网 HTTPS 或 `data:` URI |
| 会话里没有 `agnes_image` 工具 | 检查插件配置里 `enableTools` 是否为 `true` |
