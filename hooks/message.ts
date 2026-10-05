type Block = { type: string; [field: string]: unknown }

type Message = { content: Block[] }

export type ImagePolicy = 'drop' | 'pass'

export const BLOCKED_TEXT =
  '[privacy-gateway] PII の検出に失敗したため、この内容は Claude に送っていません。'

const DROPPED_MEDIA_TEXT = '[privacy-gateway] 伏せ字にできない画像・文書を 1 件除外しました。'

const MEDIA_TYPES = new Set(['image', 'document'])

/**
 * エンジンが元に戻すブロック。モデルの出力そのもので、伏せる対象ではない。
 */
const MODEL_OWN_TYPES = new Set(['thinking', 'redacted_thinking', 'tool_use'])

const isMedia = (block: Block) => MEDIA_TYPES.has(block.type)

type Masking = {
  mask: (text: string) => Promise<string>
  images: ImagePolicy
  /**
   * 伏せられずに送られる最上位のブロックを知らせる。エンジンは知らない種類のブロックを元に戻すので、
   * hook からは書き換えも削除もできない。
   */
  onUnmasked: (type: string) => void
}

/**
 * tool_result の content は文字列か、ブロックの配列のどちらか。
 */
async function maskToolResultContent(content: unknown, masking: Masking): Promise<unknown> {
  if (typeof content === 'string') return masking.mask(content)
  if (!Array.isArray(content)) return content

  return maskBlocks(content as Block[], masking, true)
}

async function maskBlocks(blocks: readonly Block[], masking: Masking, isNested: boolean): Promise<Block[]> {
  const masked: Block[] = []
  for (const block of blocks) {
    const isDroppedMedia = isMedia(block) && masking.images === 'drop'
    if (isDroppedMedia) {
      // 画像・文書は書き換えも追加もできず、削除だけが許されている
      masked.push({ type: 'text', text: DROPPED_MEDIA_TEXT })
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      masked.push({ ...block, text: await masking.mask(block.text) })
      continue
    }
    if (block.type === 'tool_result') {
      masked.push({ ...block, content: await maskToolResultContent(block.content, masking) })
      continue
    }
    const isKnownPassThrough = isMedia(block) || MODEL_OWN_TYPES.has(block.type)
    if (isKnownPassThrough) {
      masked.push(block)
      continue
    }
    if (isNested) {
      // tool_result の中身は丸ごと書き換えられるので、知らない種類は JSON の文字列にして伏せる
      masked.push({ type: 'text', text: await masking.mask(JSON.stringify(block)) })
      continue
    }
    masking.onUnmasked(block.type)
    masked.push(block)
  }

  return masked
}

/**
 * 会話の 1 行のうち、モデルが読むテキストをすべて伏せ字にする。
 */
export async function maskMessage<M extends Message>(message: M, masking: Masking): Promise<M> {
  return { ...message, content: await maskBlocks(message.content, masking, false) }
}

/**
 * 検出に失敗した行の代わりに送る中身。原文は 1 文字も残さず、tool_result の対応だけ保つ。
 */
export function blockedMessage<M extends Message>(message: M): M {
  const content: Block[] = []
  for (const block of message.content) {
    if (block.type === 'text') {
      content.push({ type: 'text', text: BLOCKED_TEXT })
      continue
    }
    if (block.type === 'tool_result') {
      content.push({ ...block, content: BLOCKED_TEXT, is_error: true })
      continue
    }
    if (isMedia(block)) continue

    content.push(block)
  }

  return { ...message, content }
}
