/**
 * Model-facing tools: `agnes_image` and `agnes_video`.
 *
 * These are the reason the plugin is a plugin rather than a web page: a Session
 * can generate a picture inline, and the picture arrives as a real DSH image
 * block (a durable attachment reference), so the model can see it and the
 * conversation renders it through the normal attachment presentation — no
 * second image pipeline, no Base64 in the transcript.
 *
 * The tool and the dashboard share one runtime, so both produce the same stored
 * record. The image path hands the committed attachment reference back; the
 * video path returns a same-origin URL because a video is not an image block.
 *
 * Contract notes, verified against the mounted DSH 0.2.2-rc.1 runtime:
 * - `ctx.tools.register(definition)` validates `parameters` and `output.schema`
 *   as RAW JSON Schema (`assertSupportedJsonSchema`). The `defineTool({...})` DSL
 *   (`{ name: { type, required } }`) belongs inside `defineTool`, which compiles
 *   it; passing that DSL straight to `register` throws
 *   `properties.x.required is not supported on type "string"`. A plugin cannot
 *   import `defineTool` without taking a runtime dependency on dsh-tools, so the
 *   definitions below are authored as raw JSON Schema instead.
 * - `required` is a property of the OBJECT schema, never of a leaf.
 * - `output.render(args, value)` returns content blocks, and an `image` block
 *   carries `{ attachment }`.
 * - `attachments.saveImage({ data, mediaType, name })` returns the durable ref.
 */

import type { Context } from '@deepseek-ai/cordis'
import { StudioError } from './errors.js'
import type { StudioRuntime } from './runtime.js'
import {
  IMAGE_RATIOS,
  IMAGE_SIZES,
  MODELS,
  VIDEO_MODES,
  VIDEO_RATIOS,
  VIDEO_SECONDS,
  VIDEO_SIZES,
  modelsFor,
  type Generation,
  type ImageRatio,
  type ImageRequest,
  type ImageSize,
  type MediaReference,
  type VideoMode,
  type VideoRatio,
  type VideoRequest,
  type VideoSeconds,
  type VideoSize,
} from './types.js'

/** The subset of the DSH tool registry this plugin uses. */
interface ToolExecution {
  readonly signal: AbortSignal
}
interface ContentBlock {
  readonly type: 'text'
  readonly text: string
}
interface ImageBlock {
  readonly type: 'image'
  readonly attachment: unknown
}
interface ToolDefinition {
  readonly name: string
  readonly description: string
  readonly parameters: Record<string, unknown>
  readonly output: {
    readonly schema: Record<string, unknown>
    render(args: unknown, value: unknown): readonly (ContentBlock | ImageBlock)[]
    presentationMeta?(args: unknown, value: unknown): Record<string, unknown>
  }
  execute(args: unknown, execution: ToolExecution): Promise<unknown>
  isConcurrencySafe?(args: unknown): boolean
  readonly timeoutMs?: number
}
interface Tools {
  register(definition: ToolDefinition): () => void
}

/** The attachment service face used to commit generated images. */
interface Attachments {
  saveImage(input: { data: Uint8Array; mediaType: string; name?: string }): Promise<unknown>
}

/** Read an optional Cordis service without declaring it required. */
function service<T>(ctx: Context, key: string): T | undefined {
  return ctx.get(key) as T | undefined
}

/** The image-generation argument shape the model supplies. */
export interface ImageArgs {
  readonly prompt: string
  readonly model?: string
  readonly size?: string
  readonly ratio?: string
  readonly referenceImages?: readonly string[]
}

/** The video-generation argument shape the model supplies. */
export interface VideoArgs {
  readonly prompt: string
  readonly model?: string
  readonly mode?: string
  readonly size?: string
  readonly ratio?: string
  readonly seconds?: number
  readonly seed?: number
  readonly firstFrame?: string
  readonly lastFrame?: string
  readonly referenceImages?: readonly string[]
}

/** The default image model id, for the tool description. */
const IMAGE_MODEL_IDS = modelsFor('image').map((model) => model.id)
const VIDEO_MODEL_IDS = modelsFor('video').map((model) => model.id)

/**
 * Turn loose model arguments into a validated request.
 *
 * The model names a model and a few knobs; the capability table decides which
 * values exist. An unknown value is refused with the accepted set in the message
 * so the model can correct itself in one turn instead of guessing.
 */
export function imageRequestFrom(args: ImageArgs): ImageRequest {
  const model = args.model ?? IMAGE_MODEL_IDS[0]
  if (model === undefined) throw new StudioError('invalid-model', '没有可用的图片模型。')
  const size = (args.size ?? '1K') as ImageSize
  const ratio = (args.ratio ?? '1:1') as ImageRatio
  if (!IMAGE_SIZES.includes(size)) throw new StudioError('invalid-parameter', `size 只支持 ${IMAGE_SIZES.join(' / ')}。`)
  if (!IMAGE_RATIOS.includes(ratio)) throw new StudioError('invalid-parameter', `ratio 只支持 ${IMAGE_RATIOS.join(' / ')}。`)
  const references: MediaReference[] = (args.referenceImages ?? []).map((url) => ({ url, kind: 'image' as const }))
  return { kind: 'image', prompt: args.prompt, model, size, ratio, references }
}

/** Turn loose model arguments into a validated video request. */
export function videoRequestFrom(args: VideoArgs): VideoRequest {
  const model = args.model ?? VIDEO_MODEL_IDS[0]
  if (model === undefined) throw new StudioError('invalid-model', '没有可用的视频模型。')
  const spec = MODELS.find((entry) => entry.id === model)
  if (spec === undefined) throw new StudioError('invalid-model', `未知的视频模型：${model}`)
  // A model that only supports 720P must not receive 1080P; the default follows
  // the model rather than the global table.
  const size = (args.size ?? spec.sizes[0]) as VideoSize
  const ratio = (args.ratio ?? '16:9') as VideoRatio
  const seconds = (args.seconds ?? 5) as VideoSeconds
  const mode = (args.mode ?? 'text') as VideoMode
  if (!VIDEO_SIZES.includes(size) || !spec.sizes.includes(size)) {
    throw new StudioError('invalid-parameter', `${model} 的 size 只支持 ${spec.sizes.join(' / ')}。`)
  }
  if (!VIDEO_RATIOS.includes(ratio)) throw new StudioError('invalid-parameter', `ratio 只支持 ${VIDEO_RATIOS.join(' / ')}。`)
  if (!VIDEO_MODES.includes(mode) || !spec.modes.includes(mode)) {
    throw new StudioError('invalid-parameter', `mode 只支持 ${spec.modes.join(' / ')}。`)
  }
  if (!spec.seconds.includes(seconds)) throw new StudioError('invalid-parameter', `seconds 只支持 ${spec.seconds.join('/')} 秒。`)
  // Frames keep their own named slots. Collecting them into a positional array
  // lost the distinction: a lone last frame became index 0 and was sent as
  // `first_frame`, so the video started on the wrong picture with no error.
  const firstFrame = typeof args.firstFrame === 'string' && args.firstFrame !== '' ? args.firstFrame : undefined
  const lastFrame = typeof args.lastFrame === 'string' && args.lastFrame !== '' ? args.lastFrame : undefined
  const hasFrame = firstFrame !== undefined || lastFrame !== undefined
  // Reference images are for `reference` mode only; frames never ride along.
  const references: MediaReference[] = hasFrame ? [] : (args.referenceImages ?? []).map((url) => ({ url, kind: 'image' as const }))
  return {
    kind: 'video',
    prompt: args.prompt,
    model,
    mode: hasFrame && mode === 'text' ? 'keyframe' : mode,
    size,
    ratio,
    seconds,
    references,
    ...(firstFrame === undefined ? {} : { firstFrame }),
    ...(lastFrame === undefined ? {} : { lastFrame }),
    ...(args.seed === undefined ? {} : { seed: args.seed }),
  }
}

/** Format one stored generation as the model-facing text envelope. */
export function describeGeneration(generation: Generation): string {
  const lines = [`${generation.kind === 'image' ? 'Image' : 'Video'} generated with ${generation.model}.`]
  if (generation.prompt.trim() !== '') lines.push(`Prompt: ${generation.prompt.trim().slice(0, 500)}`)
  const params = Object.entries(generation.params)
    .filter(([key]) => key !== 'model')
    .map(([key, value]) => `${key}=${String(value)}`)
  if (params.length > 0) lines.push(`Parameters: ${params.join(', ')}`)
  if (generation.asset !== undefined) {
    lines.push(`Stored as ${generation.id} (${generation.asset.mediaType}, ${generation.asset.bytes} bytes).`)
    if (generation.kind === 'video') {
      lines.push('Open it in the Agnes Studio panel (the sidebar entry) to play or download it.')
    }
  }
  if (generation.durationMs !== undefined) lines.push(`Took ${(generation.durationMs / 1000).toFixed(1)}s.`)
  return lines.join('\n')
}

/** Output schema shared by both tools: the stored record plus the media facts. */
export const OUTPUT_SCHEMA: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['id', 'kind', 'model', 'prompt', 'mediaType', 'bytes', 'src'],
  properties: {
    id: { type: 'string' },
    kind: { type: 'string', enum: ['image', 'video'] },
    model: { type: 'string' },
    prompt: { type: 'string' },
    mediaType: { type: 'string' },
    bytes: { type: 'integer' },
    src: { type: 'string' },
    image: {
      type: 'object',
      description: 'Present for image generations: the durable attachment reference.',
    },
  },
}

/** The `agnes_image` parameter schema, as registered. */
export const IMAGE_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description:
        'What to draw. Structure it as subject + scene + style + lighting + composition + quality. For an edit, state what changes and what must stay the same.',
    },
    model: {
      type: 'string',
      description: `Image model id. Default ${IMAGE_MODEL_IDS[0]}.`,
      enum: [...IMAGE_MODEL_IDS],
    },
    size: {
      type: 'string',
      description: 'Resolution tier; higher tiers take longer and are larger.',
      enum: [...IMAGE_SIZES],
    },
    ratio: {
      type: 'string',
      description: 'Aspect ratio of the output.',
      enum: [...IMAGE_RATIOS],
    },
    referenceImages: {
      type: 'array',
      description:
        'Up to 8 publicly reachable HTTPS image URLs, or data: URIs, used as image-to-image input or multi-image composition. Omit for text-to-image.',
      items: { type: 'string' },
    },
  },
}

/** The `agnes_video` parameter schema, as registered. */
export const VIDEO_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  required: ['prompt'],
  properties: {
    prompt: {
      type: 'string',
      description:
        'What happens in the shot: subject and setting, action, camera language, visual style, sound, and what must stay consistent.',
    },
    model: {
      type: 'string',
      description: `Video model id. Default ${VIDEO_MODEL_IDS[0]}; the flash model is fixed to 720P.`,
      enum: [...VIDEO_MODEL_IDS],
    },
    mode: {
      type: 'string',
      description: 'text = prompt only; keyframe = first/last frame images; reference = style/motion references.',
      enum: [...VIDEO_MODES],
    },
    size: {
      type: 'string',
      description: 'Resolution tier; agnes-video-2.5-flash accepts only 720P.',
      enum: [...VIDEO_SIZES],
    },
    ratio: { type: 'string', description: 'Aspect ratio of the output.', enum: [...VIDEO_RATIOS] },
    seconds: { type: 'integer', description: 'Duration in seconds (4–12).', enum: [...VIDEO_SECONDS] },
    seed: { type: 'integer', description: 'Optional random seed for reproducibility.' },
    firstFrame: { type: 'string', description: 'keyframe mode: publicly reachable URL of the first frame.' },
    lastFrame: { type: 'string', description: 'keyframe mode: publicly reachable URL of the last frame.' },
    referenceImages: {
      type: 'array',
      description: 'reference mode: up to 8 public HTTPS image URLs used as style or content references.',
      items: { type: 'string' },
    },
  },
}

/** Register both model tools when the profile mounts a tool registry. */
export function registerAgentTools(ctx: Context, runtime: StudioRuntime, attachments: () => Attachments | undefined): void {
  const tools = service<Tools>(ctx, 'tools')
  if (!tools) return

  ctx.effect(() => {
    const disposer = tools.register({
      name: 'agnes_image',
      description:
        'Generate an image with Agnes AI (free image models) and show it in this conversation. Use it whenever the user asks for a picture, illustration, poster, product shot, icon, concept art, or an edit of an existing image. The result is stored and rendered inline.',
      parameters: IMAGE_PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          const data = (value ?? {}) as Record<string, unknown>
          const text = describeGeneration({
            id: String(data['id'] ?? ''),
            kind: 'image',
            status: 'succeeded',
            model: String(data['model'] ?? ''),
            prompt: String(data['prompt'] ?? ''),
            params: {},
            createdAt: new Date().toISOString(),
            asset: {
              src: String(data['src'] ?? ''),
              mediaType: String(data['mediaType'] ?? 'image/png'),
              bytes: Number(data['bytes'] ?? 0),
            },
          })
          const attachment = data['image']
          if (attachment !== undefined && attachment !== null) {
            return [{ type: 'text', text }, { type: 'image', attachment }]
          }
          return [{ type: 'text', text }]
        },
      },
      timeoutMs: 380_000,
      // Two image generations may run at once; they do not share state.
      isConcurrencySafe: () => true,
      async execute(raw, execution) {
        execution.signal.throwIfAborted()
        const args = (raw ?? {}) as ImageArgs
        const request = imageRequestFrom(args)
        const generation = await runtime.generate(request, { signal: execution.signal })
        if (generation.asset === undefined) throw new StudioError('internal', '图片已生成但没有保存结果。')
        const store = attachments()
        let imageRef: unknown
        if (store !== undefined) {
          const media = await runtime.readMedia(generation.id)
          if (media !== undefined) {
            // The durable attachment is what the Chat row renders and what the
            // model receives; the stored file stays the plugin's own copy so the
            // panel and the conversation show the same picture.
            imageRef = await store.saveImage({
              data: media.bytes,
              mediaType: media.mediaType,
              name: `agnes-${generation.id}${extensionFor(media.mediaType)}`,
            })
          }
        }
        return {
          id: generation.id,
          kind: 'image',
          model: generation.model,
          prompt: generation.prompt,
          mediaType: generation.asset.mediaType,
          bytes: generation.asset.bytes,
          src: generation.asset.src,
          ...(imageRef === undefined ? {} : { image: imageRef }),
        }
      },
    })
    return disposer
  }, 'skillre-agnes-studio image tool')

  ctx.effect(() => {
    const disposer = tools.register({
      name: 'agnes_video',
      description:
        'Generate a short video (4–12 seconds) with Agnes AI and store it in Agnes Studio. Use it when the user asks for a video, animation, or a moving shot. Supports text-to-video, first/last-frame control and image/audio/video references. Generation is asynchronous and can take minutes; a full queue is reported as retryable.',
      parameters: VIDEO_PARAMETERS,
      output: {
        schema: OUTPUT_SCHEMA,
        render(_args, value) {
          const data = (value ?? {}) as Record<string, unknown>
          return [{ type: 'text', text: describeGeneration({
            id: String(data['id'] ?? ''),
            kind: 'video',
            status: 'succeeded',
            model: String(data['model'] ?? ''),
            prompt: String(data['prompt'] ?? ''),
            params: {},
            createdAt: new Date().toISOString(),
            asset: {
              src: String(data['src'] ?? ''),
              mediaType: String(data['mediaType'] ?? 'video/mp4'),
              bytes: Number(data['bytes'] ?? 0),
            },
          }) }]
        },
      },
      timeoutMs: 920_000,
      // Video tasks share an upstream queue; running two at once only deepens it.
      isConcurrencySafe: () => false,
      async execute(raw, execution) {
        execution.signal.throwIfAborted()
        const args = (raw ?? {}) as VideoArgs
        const request = videoRequestFrom(args)
        const generation = await runtime.generate(request, { signal: execution.signal })
        if (generation.asset === undefined) throw new StudioError('internal', '视频已生成但没有保存结果。')
        return {
          id: generation.id,
          kind: 'video',
          model: generation.model,
          prompt: generation.prompt,
          mediaType: generation.asset.mediaType,
          bytes: generation.asset.bytes,
          src: generation.asset.src,
        }
      },
    })
    return disposer
  }, 'skillre-agnes-studio video tool')
}

/** File extension for an attachment display name. */
function extensionFor(mediaType: string): string {
  switch (mediaType) {
    case 'image/png':
      return '.png'
    case 'image/jpeg':
      return '.jpg'
    case 'image/webp':
      return '.webp'
    case 'image/gif':
      return '.gif'
    default:
      return '.png'
  }
}
