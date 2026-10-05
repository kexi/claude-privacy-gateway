type Block = { type: string; [field: string]: unknown }

type Message = { content: Block[] }

export type ImagePolicy = 'drop' | 'pass'

export const BLOCKED_TEXT =
  '[privacy-gateway] PII の検出に失敗したため、この内容は Claude に送っていません。'

const DROPPED_MEDIA_TEXT = '[privacy-gateway] 伏せ字にできない画像・文書を 1 件除外しました。'

const MEDIA_TYPES = new Set(['image', 'document'])

const isMedia = (block: Block) => MEDIA_TYPES.has(block.type)

/**
 * tool_result の content は文字列か、text / image ブロックの配列のどちらか。
 */
async function maskToolResultContent(
  content: unknown,
  mask: (text: string) => Promise<string>,
  images: ImagePolicy,
): Promise<unknown> {
  if (typeof content === 'string') return mask(content)
  if (!Array.isArray(content)) return content

  return maskBlocks(content as Block[], mask, images)
}

async function maskBlocks(
  blocks: readonly Block[],
  mask: (text: string) => Promise<string>,
  images: ImagePolicy,
): Promise<Block[]> {
  const masked: Block[] = []
  for (const block of blocks) {
    const isDroppedMedia = isMedia(block) && images === 'drop'
    if (isDroppedMedia) {
      // 画像・文書は書き換えも追加もできず、削除だけが許されている
      masked.push({ type: 'text', text: DROPPED_MEDIA_TEXT })
      continue
    }
    if (block.type === 'text' && typeof block.text === 'string') {
      masked.push({ ...block, text: await mask(block.text) })
      continue
    }
    if (block.type === 'tool_result') {
      masked.push({ ...block, content: await maskToolResultContent(block.content, mask, images) })
      continue
    }
    // thinking / tool_use など、エンジンが元に戻すブロックはそのまま渡す
    masked.push(block)
  }

  return masked
}

/**
 * 会話の 1 行のうち、モデルが読むテキストをすべて伏せ字にする。
 */
export async function maskMessage<M extends Message>(
  message: M,
  mask: (text: string) => Promise<string>,
  images: ImagePolicy,
): Promise<M> {
  return { ...message, content: await maskBlocks(message.content, mask, images) }
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
