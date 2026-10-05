import type { HttpResponse, On } from 'claude-code'

import type { Port } from '../../hooks/gateway'

/**
 * Gemma の応答（chat completions）を作る。`names` のうち断片に含まれるものを PERSON として返す。
 */
function completionFor(chunk: string, names: readonly string[]): HttpResponse {
  const entities = names.filter(name => chunk.includes(name)).map(text => ({ text, type: 'PERSON' }))
  const completion = { choices: [{ message: { content: JSON.stringify({ entities }) } }] }

  return { status: 200, ok: true, headers: {}, text: JSON.stringify(completion) }
}

const chunkOf = (body: string | undefined) => {
  const parsed = JSON.parse(body ?? '{}') as { messages?: { content?: string }[] }

  return parsed.messages?.[1]?.content ?? ''
}

const DOWN: HttpResponse = { status: 503, ok: false, headers: {}, text: 'model not loaded' }

/**
 * Gemma（`$.http.fetch` の先）の代わりに立つ。問い合わせられた断片を記録して返す。
 */
export function gemmaFinding(on: On, names: readonly string[]): string[] {
  const asked: string[] = []
  on('http.fetch', ($, e) => {
    const chunk = chunkOf(e.init?.body)
    asked.push(chunk)

    return { value: completionFor(chunk, names) }
  })

  return asked
}

/**
 * 止まっている Gemma。どの問い合わせにも 503 を返す。
 */
export function gemmaDown(on: On): void {
  on('http.fetch', () => ({ value: DOWN }))
}

/**
 * テストには描く画面がないので、ステータス行とログを受け流す。
 */
export function quietUi(on: On): void {
  on('ui.status', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
}

/**
 * エンジンを介さずに Gateway を動かすための入出力。Gemma は `names` を見つけ、対応表はメモリに置く。
 */
export function portFinding(names: readonly string[] | 'down'): Port {
  let saved = { entries: [] as [string, string, string][] }

  return {
    fetch: async (url, init) => (names === 'down' ? DOWN : completionFor(chunkOf(init.body), names)),
    load: async () => saved,
    save: async change => {
      saved = change(saved)

      return saved
    },
    log: () => {},
    status: () => {},
    trace: () => {},
  }
}
