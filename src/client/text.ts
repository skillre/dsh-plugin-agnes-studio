/**
 * Client dictionaries.
 *
 * Two locales ship with the bundle: Simplified Chinese (the authoring language)
 * and English. Keys are flat and dot-namespaced, resolved through the shared
 * `locale` service, so switching the GUI language re-renders the panel without a
 * reload. The Chinese key set is the source of truth: a key that exists only in
 * English is a bug, and `text.spec` asserts the two sets match.
 */

/** The namespace registered with the Client locale service. */
export const NAMESPACE = 'skillreAgnesStudio'

/** The translate function the locale service binds for one namespace. */
export type Translate = (key: string, params?: Record<string, string | number>) => string

/** Chinese dictionary; the key set is the source of truth. */
export const zh: Record<string, string> = {
  'nav': 'Agnes 工作室',
  'title': 'Agnes 工作室',
  'subtitle': '用 Agnes 的免费模型生成图片和视频：调参数、看结果、直接下载。',
  'tab.image': '生图',
  'tab.video': '生视频',

  'config.title': '还没有配置 API Key',
  'config.body': '在 DSH 凭据中设置 AGNES_API_KEY，或设置同名环境变量后重试。密钥只在 Host 侧使用，不会发送到浏览器。',
  'config.source.credential': '密钥来自 DSH 凭据',
  'config.source.environment': '密钥来自环境变量',
  'config.source.none': '未配置密钥',
  'config.models': '上游可用模型：{count} 个',

  'form.prompt': '提示词',
  'form.promptPlaceholder': '描述你想要的画面：主体 + 场景 + 风格 + 光线 + 构图 + 画质。改图时说明「改什么、保留什么」。',
  'form.model': '模型',
  'form.size': '分辨率',
  'form.ratio': '比例',
  'form.mode': '模式',
  'form.seconds': '时长（秒）',
  'form.seed': '随机种子（可选）',
  'form.seedPlaceholder': '留空表示随机',
  'form.references': '参考图 URL（可选）',
  'form.referencePlaceholder': 'https://… 公网可访问的图片地址',
  'form.addReference': '添加参考图',
  'form.removeReference': '移除',
  'form.firstFrame': '首帧图片 URL',
  'form.lastFrame': '尾帧图片 URL',
  'form.submitImage': '生成图片',
  'form.submitVideo': '生成视频',
  'form.needPrompt': '请先填写提示词',
  'form.needKeyframe': 'keyframe 模式需要首帧或尾帧图片',
  'form.needReference': 'reference 模式需要至少一个参考素材',

  'mode.text': '纯文本',
  'mode.keyframe': '首尾帧',
  'mode.reference': '参考素材',

  'status.generatingImage': '正在生成图片，通常需要 10–60 秒…',
  'status.generatingVideo': '正在生成视频，可能需要几分钟，请保持页面打开…',
  'status.failed': '生成失败',

  'gallery.title': '生成记录',
  'gallery.count': '{count} 条',
  'gallery.empty': '还没有生成记录。填好上面的提示词，点一下生成试试。',
  'gallery.emptyFiltered': '这个分类下还没有记录。',
  'gallery.all': '全部',
  'gallery.images': '图片',
  'gallery.videos': '视频',
  'gallery.delete': '删除',
  'gallery.clear': '清空全部',
  'gallery.confirmClear': '确定删除全部生成记录？文件也会一并删除。',
  'gallery.confirmDelete': '确定删除这条记录？',
  'gallery.retry': '重试',
  'gallery.download': '下载',
  'gallery.open': '打开原图',
  'gallery.viewer': '查看大图',
  'gallery.close': '关闭',
  'gallery.zoomIn': '放大',
  'gallery.zoomOut': '缩小',
  'gallery.resetZoom': '还原',
  'gallery.hint': '滚轮缩放、拖动平移、Esc 关闭',
  'gallery.took': '耗时 {seconds} 秒',
  'gallery.loading': '加载中…',

  'error.retryable': '这个问题通常是暂时的，可以原样重试。',
  'error.not-configured': '还没有配置 Agnes API Key。',
  'error.queue-full': 'Agnes 视频队列已满，请稍后重试。',
  'error.timeout': '等待超时。任务可能仍在 Agnes 侧生成。',
  'error.unauthorized': 'API Key 无效或没有该模型权限。',
  'error.rate-limited': '请求太频繁，已被限流。',
  'error.cancelled': '请求已取消。',
  'error.unknown': '出错了',

  'action.dismiss': '知道了',

  'hint.dimensions': '预计输出 {width}×{height}',
  'hint.videoSlow': '视频是异步任务：提交后会轮询 Agnes 直到完成。',
  'hint.key': '也可以在会话里直接让我生成：说「画一张…」或「生成一段…视频」。',
}

/** English dictionary; every key mirrors {@link zh}. */
export const en: Record<string, string> = {
  'nav': 'Agnes Studio',
  'title': 'Agnes Studio',
  'subtitle': "Generate images and video with Agnes' free models: tune the parameters, see the result, download it.",
  'tab.image': 'Images',
  'tab.video': 'Video',

  'config.title': 'No API key configured yet',
  'config.body': 'Set AGNES_API_KEY in DSH credentials, or export the same environment variable, then try again. The key is used on the Host only and is never sent to the browser.',
  'config.source.credential': 'Key from DSH credentials',
  'config.source.environment': 'Key from the environment',
  'config.source.none': 'No key configured',
  'config.models': 'Upstream models: {count}',

  'form.prompt': 'Prompt',
  'form.promptPlaceholder': 'Describe the shot: subject + scene + style + lighting + composition + quality. For an edit, say what changes and what must stay.',
  'form.model': 'Model',
  'form.size': 'Resolution',
  'form.ratio': 'Aspect ratio',
  'form.mode': 'Mode',
  'form.seconds': 'Duration (s)',
  'form.seed': 'Seed (optional)',
  'form.seedPlaceholder': 'Blank means random',
  'form.references': 'Reference image URLs (optional)',
  'form.referencePlaceholder': 'https://… a publicly reachable image URL',
  'form.addReference': 'Add reference',
  'form.removeReference': 'Remove',
  'form.firstFrame': 'First-frame image URL',
  'form.lastFrame': 'Last-frame image URL',
  'form.submitImage': 'Generate image',
  'form.submitVideo': 'Generate video',
  'form.needPrompt': 'Enter a prompt first',
  'form.needKeyframe': 'Keyframe mode needs a first or last frame image',
  'form.needReference': 'Reference mode needs at least one reference',

  'mode.text': 'Text only',
  'mode.keyframe': 'Keyframes',
  'mode.reference': 'References',

  'status.generatingImage': 'Generating the image — usually 10–60 seconds…',
  'status.generatingVideo': 'Generating the video — this can take minutes, keep the page open…',
  'status.failed': 'Generation failed',

  'gallery.title': 'History',
  'gallery.count': '{count}',
  'gallery.empty': 'Nothing generated yet. Write a prompt above and hit generate.',
  'gallery.emptyFiltered': 'Nothing in this category yet.',
  'gallery.all': 'All',
  'gallery.images': 'Images',
  'gallery.videos': 'Video',
  'gallery.delete': 'Delete',
  'gallery.clear': 'Clear all',
  'gallery.confirmClear': 'Delete every generation? The files are removed too.',
  'gallery.confirmDelete': 'Delete this generation?',
  'gallery.retry': 'Retry',
  'gallery.download': 'Download',
  'gallery.open': 'Open original',
  'gallery.viewer': 'View image',
  'gallery.close': 'Close',
  'gallery.zoomIn': 'Zoom in',
  'gallery.zoomOut': 'Zoom out',
  'gallery.resetZoom': 'Reset zoom',
  'gallery.hint': 'Scroll to zoom, drag to pan, Esc to close',
  'gallery.took': 'Took {seconds}s',
  'gallery.loading': 'Loading…',

  'error.retryable': 'This is usually temporary — retrying unchanged may work.',
  'error.not-configured': 'No Agnes API key configured yet.',
  'error.queue-full': 'The Agnes video queue is full — try again shortly.',
  'error.timeout': 'Timed out waiting. The task may still be running on Agnes.',
  'error.unauthorized': 'The API key is invalid or lacks access to this model.',
  'error.rate-limited': 'Rate limited — too many requests.',
  'error.cancelled': 'The request was cancelled.',
  'error.unknown': 'Something went wrong',

  'action.dismiss': 'Dismiss',

  'hint.dimensions': 'Expected output {width}×{height}',
  'hint.videoSlow': 'Video is an async task: after submitting, the Host polls Agnes until it finishes.',
  'hint.key': 'You can also ask me in a session: say "draw a …" or "generate a … video".',
}

/** Read one key from a dictionary, falling back to the key itself. */
export function textOf(dict: Record<string, string>, key: string): string {
  return dict[key] ?? key
}

/** Pick the dictionary for a locale id, falling back to English. */
export function dictFor(locale: string): Record<string, string> {
  return locale.toLowerCase().startsWith('zh') ? zh : en
}
