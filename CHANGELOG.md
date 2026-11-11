# Changelog

## 0.3.0

### Minor Changes

- 看板支持后台任务、修复离场后重试失效，并新增提示词优化。
  
  **任务在 Host 上跑，不再随看板卸载而丢失。** 之前「在跑」这个标记只是客户端组件里的状态：切出去
  任务确实还在跑（Host 侧的 fetch 没有断），但组件卸载后标记就没了，于是切回来看到的是一个空闲面板，
  只能干等或以为任务丢了。现在生成请求登记为一个 Host 持有的 job，立刻返回，工作与 HTTP 请求解耦；
  `state` 里多出 `running` 列表，看板在有任务时轮询它，回来就能接着看到进度条。实测：提交生图 → 切走
  → 切回，任务仍在跑并显示进度，跑完自动变成结果卡片。任务也提供「取消」，取消不留失败记录。
  
  **重试改为按记录 id 走 Host。** 之前重试依赖客户端内存里「上次提交的请求」，离开看板再回来（或刷新
  页面）这段内存就没了，于是点「重试」没有任何反应 —— 这正是反馈的缺陷。现在点击重试只把记录 id 交给
  Host，由 Host 用**该记录自己保存的原始请求**重新发起，因此离开、返回、整页刷新后都能重试。实测：生视频
  失败 → 整页刷新 → 点重试 → 真的发起任务，且卡片数不增加。顺带修掉两个同源问题：重试会**原地更新**那一条
  记录（之前每点一次就多一条相同失败记录），并且重试请求的是**这张卡片自己的**请求（之前会误用「最后
  提交的」请求，把别的生成重新跑一遍）。
  
  **提示词优化。** 提示词框新增「优化提示词」，调用 Agnes 文字模型 `agnes-3.0-flash` 把草稿写具体；
  生图与生视频给不同建议（构图/光比/镜头 vs 运动/运镜/节奏），保持用户原来的语言与主体。改写可「撤销」
  回到原文，继续手动编辑即视为接受。
  
  **错误说明更准确。** 视频 503 `video_queue_full` 现在明确说明是上游并发容量限制、不是请求有问题
  （实测该状态可连续持续数分钟）；新增 403 `insufficient_user_quota` 的独立映射 —— 之前它会落进
  401/403 分支被报成「API Key 无效」，而 Key 其实是好的，只是余额不足。
  
  **布局。** 参数区左对齐贴住内容区左边缘。之前 `.agnes` 在 flex 父容器里按内容收缩到 953px，又被
  `margin: 0 auto` 居中，在 1232px 宽的列里留下两边各 139.5px 的空档；现在撑满整列，左空隙与右空隙
  实测都是 22px（即 padding），画廊拿到剩余全部宽度。
  
  验证：159 项离线测试（新增 14 项：state 报告在跑任务、后台失败落成记录、取消不留记录、dispose
  中止全部任务、被取消的任务无论客户端抛什么错误都不落记录、优化提示词及其空输入拒绝、按 id 重试、
  重试原地替换、非法参数在注册 job 之前即同步拒绝）；
  31 项真实 headless Chrome 检查（新增提示词优化按钮就位、空闲时不出现假的「生成中」）；隔离 profile
  内 23 项打包验证（新增「提交后能在 state.running 里看到任务」）；另做了带真实 key 的端到端实测
  （后台任务跨离开/返回、以及跨整页刷新均存活，刷新后重试生效，优化提示词真实改写并可撤销）。新增测试都做过反向验证：
  把实现改回旧行为会让对应测试失败。

### Patch Changes

- 2444efa: 修复 UI 验证脚本的临时 profile 清理竞态：删除成功后立刻退出循环，而仍在退出的 DSH 进程随后会把
  session 缓存写回刚删掉的目录，于是在临时根目录留下 `home/storages/...`。之前的重试只在「删除失败」
  时生效，而第一次 `rm` 是成功的，所以重试从未触发 —— 实际在失败运行后发现了三个残留目录。
  
  现在判据从「删除是否成功」改为「目录是否保持消失」：删除后等待 400ms 再检查，连续两次确认不存在
  才算干净，最多 12 轮；若仍残留，报错会列出残留文件路径，而不是只报一句清理失败。
  外层驱动 `ui-check.mjs` 有同一处竞态，一并修掉。
  
  只影响开发用的验证脚本，不进发布包。

## 0.2.0

### Minor Changes

- 重做看板的视觉与交互，并补上结果浏览的缺失能力。
  
  **布局**：原来是一列从上往下的全宽表单 + 全宽画廊，每个输入框都被拉到 1200px 宽，提示词输入框
  成了一条扁条，而结果起始位置在首屏之外。现在改成左参数区、右画廊的双栏布局，两栏各自滚动，
  生成按钮固定在参数区底部 —— 之前视频页的表单比可视区高，生成按钮落在折叠线以下，面板最主要的
  操作要先滚动页面才能点到。
  
  **参数控件按选项数量选形态**：2–4 个互斥选项（分辨率、视频模式）用分段控件全部摊开；8 种比例、
  9 个时长用胶囊标签，比例标签自己画出对应的小方框，扫一眼比读「21:9」快。原来所有参数都是
  `<select>`，把所有备选藏在弹层里 —— 对一个「选项之间确实有区别」的分辨率选择来说正好是反的。
  
  **配色改用宿主设计令牌**：之前所有表面都是 `color-mix(currentColor N%)`，在浅色主题下卡片、
  输入框、标签会塌成同一片近白，深色主题下塌成同一片近黑，整块面板没有层次。现在读
  `--dsw-*`（`bg-layer-*`、`border-l*`、`label-*`、`radius-*`、`elevation-*`），沿用应用本身的
  表面、边框、圆角与投影，明暗两套主题都跟随宿主。
  
  **主按钮**：之前禁用态是渐变加 45% 不透明度，在白底上就是一块淡紫色板上写白字，读不出内容，
  看起来像坏了而不是不可用。现在禁用态是平铺的浅表面 + 可读标签，渐变只在可用时以全强度出现。
  
  **其他**：模型说明（`note`）现在显示在控件下方，解释了分辨率为什么会被收窄；提示词带字数计数和
  示例标签；生成中有骨架卡片占住结果位置；空状态有图标和说明；缩略图统一 4:3 裁切（否则参差的
  自然比例会让网格下方出现空洞），悬停时浮出「查看大图」；分类筛选改成 tablist 并真的过滤。
  
  **图片查看器**：顶栏加了标题与参数、缩放读数和成组的缩放控件，缩放上下限会禁用对应按钮；
  支持左右方向键在多张图之间连续翻看并逐图重置缩放，关闭后焦点回到触发它的控件。之前只有工具栏
  按钮和 Esc，翻看下一张必须先关掉再打开。
  
  验证：145 项离线测试（新增 8 项，其中查看器翻页、缩放重置、焦点归位为新增覆盖）；29 项真实
  headless Chrome 检查（新增双栏几何、控件形态、按钮可达性、筛选真实生效、明暗主题实测配色、
  翻页与方向键）。新增检查都做过反向验证：把实现改回旧行为会让对应检查失败。

## 0.1.1

### Patch Changes

- 2072a05: Fix "打开原图" doing nothing, and replace it with an in-panel image viewer.
  
  - **The defect**: the control was an `<a target="_blank">` to the stored media URL. The Desktop shell
    denies every popup the page requests and only forwards `https:` URLs to the OS browser, so clicking
    it had no effect at all; the URL is also session-authenticated, so an external tab would have
    answered 401. It rendered, focused, and did nothing.
  - **The fix**: the panel owns the zoom. Clicking "打开原图" or the thumbnail opens a lightbox that
    covers the window, with a zoom readout, zoom in/out/reset controls, a download link and a close
    button. Click the picture to toggle between fit and 2x centred on the click point, scroll to zoom
    between 1x and 8x, drag to pan while zoomed, and press Escape, click the backdrop or use the close
    button to dismiss. The viewer is keyed by record id, so a Host state refresh does not close it.
  - The overlay renders in the component tree with `position: fixed` rather than through a portal: the
    browser bundle's module envelope resolves only `react`, so importing `react-dom` would break
    loading.
  - Wheel zoom binds natively with `passive: false`; React's synthetic wheel listener is passive at the
    root, where `preventDefault()` is ignored and the panel behind the overlay would scroll.
  - Pointer input with unusable coordinates no longer starts a pan. jsdom has no `PointerEvent`, and an
    undefined origin previously wrote `translate(NaNpx, NaNpx)` and blanked the picture.
  - Verification: 8 new offline viewer tests drive the actual interaction (the previous suite could not
    catch this class of defect, because DOM presence passes on a control that does nothing), and the
    headless-Chrome check now asserts that the overlay spans the viewport with no containing-block trap
    and that zoom changes the measured layout, not just the label.

This file is maintained by Changesets. The generated project shell has not been released.
