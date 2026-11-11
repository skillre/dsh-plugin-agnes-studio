# 预览图画板

详情页的预览图以**飞书画板**为编辑源，`docs/preview*.svg` 是它的导出快照。
本文件记录两种语言各自对应的画板，供 `node scripts/preview.mjs push|pull` 使用。

| 语言 | 文档 | 画板 token |
|---|---|---|
| `en` | （待填：飞书文档 URL） | （待填：whiteboard token） |
| `zh` | （待填：飞书文档 URL） | （待填：whiteboard token） |

> 当前 `docs/preview.svg` / `docs/preview.zh.svg` 是手工编写的自包含 SVG（同一幅图，两种语言），
> 已通过 `node scripts/preview.mjs check`：640×300 比例、元素集在飞书画板解析器支持范围内、
> 无外部引用、在 500 KiB 预算内。第一次上板时按下面的命令推送，再把 token 回填到上表。

## 操作

```sh
# 把本地 SVG 推上画板（整板重建）
node scripts/preview.mjs push --lang zh

# 从画板导出 SVG 覆盖本地文件
node scripts/preview.mjs pull --lang zh

# 离线校验（npm run check 会自动调用）
node scripts/preview.mjs check
```

规则见 fleet 的 `docs/display-contract.md`。
