import type { HttpInit, HttpResponse } from 'claude-code'

import { TOKEN_SOURCE } from '../vault'
import type { Finding } from './regex'

export type GemmaConfig = { url: string; model: string }

/**
 * `$.http.fetch` を包んだ関数。`$` は呼び出し箇所でしか綴れないため、hook 側で作って渡す。
 */
export type Fetch = (url: string, init: HttpInit) => Promise<HttpResponse>

/**
 * Gemma に一度に渡す文字数。長いツール結果は行単位でこの大きさに切って並べて問い合わせる。
 *
 * `$.http.fetch` には 1 回 30 秒の上限がある（2.1.289 で観測。超えると HooksError で切られる）。
 * LM Studio は前処理をほぼ 1 件ずつこなすので、1 件の待ち時間は「前に並ぶ件数 × 1 件の前処理時間」になる。
 * Why not 3000 字: 起動直後に 7 件（各 1,300 トークン前後）が並び、後ろの数件が 30 秒を超えて差し止められた。
 */
const CHUNK_CHARS = 1500

/**
 * 1 回の検査で同時に投げる問い合わせ数。起動直後は複数の hook が同時に検査するので、合計が膨らまないよう小さく抑える。
 */
const CONCURRENCY = 2

const CATEGORIES = new Set(['PERSON', 'ADDRESS', 'BIRTHDATE', 'ID', 'SECRET'])

/**
 * 文字（かな・漢字・ラテン文字）を 1 つも含まない行は人名も住所も持たないので問い合わせない。
 */
const HAS_LETTER = /[A-Za-z\u3040-\u30ff\u3400-\u9fff]/

const TOKEN_EXACT = new RegExp(`^${TOKEN_SOURCE}$`)

const SYSTEM_PROMPT = `You are a PII and secret detector. Read the user's text and list every substring that is personal or confidential data about a real individual.

Types:
- PERSON: a real person's name (family name, given name, full name, nickname, romanized name). A word followed by さん, 様, 氏, 君, ちゃん, 先生 or 医師 is a name. Names inside code comments and string literals count.
- ADDRESS: a postal address or a part of one (prefecture, city, street, building)
- BIRTHDATE: a date of birth
- ID: an identifier tied to a person (patient ID, medical record number, insurance number, employee number, account number)
- SECRET: a password, passphrase, token or other credential

Do NOT list:
- identifiers in source code (variable, function, property, type names) even if they look like names
- placeholders of the form __PII_<TYPE>_<n>__
- names of companies, products, services, or software (GitHub, Anthropic, Claude, octocat as a product mascot)
- generic words and roles (患者, 医師, user)

Copy each substring exactly as it appears in the text, character for character. Output JSON only, no prose, no code fence:
{"entities":[{"text":"<exact substring>","type":"<TYPE>"}]}
If there is nothing, output {"entities":[]}.`

export class DetectorError extends Error {
  override name = 'DetectorError'
}

/**
 * Gemma に渡す塊と、その塊が答えを持つ行（キャッシュのキー）。
 */
export type Chunk = { text: string; keys: string[] }

const keyOf = (line: string) => line.trim()

/**
 * 行の並びを CHUNK_CHARS 以下の塊にまとめる。1 行が長すぎるときだけ行の途中で切り、
 * その行のキーは切った塊すべてに載せる。
 */
export function chunksOf(lines: readonly string[]): Chunk[] {
  const chunks: Chunk[] = []
  let current: Chunk = { text: '', keys: [] }
  const flush = () => {
    if (current.text !== '') chunks.push(current)
    current = { text: '', keys: [] }
  }
  for (const line of lines) {
    const isOverflowing = current.text.length + line.length > CHUNK_CHARS
    if (isOverflowing) flush()

    const isLongLine = line.length > CHUNK_CHARS
    if (!isLongLine) {
      current.text += line
      current.keys.push(keyOf(line))
      continue
    }
    for (let start = 0; start < line.length; start += CHUNK_CHARS) {
      chunks.push({ text: line.slice(start, start + CHUNK_CHARS), keys: [keyOf(line)] })
    }
  }
  flush()

  return chunks
}

/**
 * 同時に走らせる問い合わせを max 件に抑える。
 */
function limiter(max: number) {
  let active = 0
  const waiting: (() => void)[] = []

  return <T>(task: () => Promise<T>): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      const run = () => {
        active++
        task()
          .then(resolve, reject)
          .finally(() => {
            active--
            waiting.shift()?.()
          })
      }
      if (active < max) run()
      else waiting.push(run)
    })
}

/**
 * Gemma の答えから JSON を取り出し、本文に実在する部分文字列だけを残す（幻覚した値を伏せ字にしない）。
 */
export function findingsOf(answer: string, chunk: string): Finding[] {
  const start = answer.indexOf('{')
  const end = answer.lastIndexOf('}')
  const hasObject = start !== -1 && end > start
  if (!hasObject) throw new DetectorError('Gemma の応答に JSON がありません')

  const parsed: unknown = JSON.parse(answer.slice(start, end + 1))
  const entities = (parsed as { entities?: unknown }).entities
  if (!Array.isArray(entities)) throw new DetectorError('Gemma の応答に entities がありません')

  const findings: Finding[] = []
  for (const entity of entities as { text?: unknown; type?: unknown }[]) {
    const value = typeof entity.text === 'string' ? entity.text.trim() : ''
    const isUsable = value.length >= 2 && chunk.includes(value) && !TOKEN_EXACT.test(value)
    if (!isUsable) continue

    const type = typeof entity.type === 'string' ? entity.type.toUpperCase() : ''
    findings.push({ value, category: CATEGORIES.has(type) ? type : 'PII' })
  }

  return findings
}

/**
 * 30 秒で切られた問い合わせと、サーバの一時的な失敗（5xx）を送り直す回数の上限（初回を含む）。
 *
 * LM Studio はクライアントが切れても前処理を終えてキャッシュするので、同じ問い合わせを送り直すと
 * 続きから速く返る（1,500 字の塊で 12.3 秒 → 2.5 秒を観測）。mlx-vlm の DiffusionGemma は負荷がかかると
 * Metal の打ち切り（Impacting Interactivity）で 500 を返すことがあり、送り直せば通る。
 * 送り直している間も自分の `$` 呼び出しが走っているので、hook の持ち時間（10 秒）は減らない。
 */
const ATTEMPTS = 5

async function fetchPatiently(fetch: Fetch, url: string, init: HttpInit): Promise<HttpResponse> {
  for (let attempt = 1; ; attempt++) {
    const isLastAttempt = attempt >= ATTEMPTS
    try {
      const response = await fetch(url, init)
      const isServerError = response.status >= 500
      if (!isServerError || isLastAttempt) return response
    } catch (error) {
      if (isLastAttempt) throw error
    }
  }
}

async function ask(fetch: Fetch, config: GemmaConfig, chunk: string): Promise<Finding[]> {
  const response = await fetchPatiently(fetch, config.url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      max_tokens: 1024,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: chunk },
      ],
    }),
  })
  if (!response.ok) throw new DetectorError(`Gemma が HTTP ${response.status} を返しました`)

  const body = JSON.parse(response.text) as { choices?: { message?: { content?: string } }[] }
  const answer = body.choices?.[0]?.message?.content
  if (typeof answer !== 'string') throw new DetectorError('Gemma の応答に本文がありません')

  return findingsOf(answer, chunk)
}

/**
 * Gemma の結果を行ごとに覚えるキャッシュ。キーは前後の空白を除いた行、値はその行を含めて問い合わせた
 * 塊の結果。問い合わせ中の行は同じ Promise を待つ。
 *
 * Why not 塊単位で覚える: CLAUDE.md のように同じ本文が枠の文言だけ変えて何度も届く（prompt.context、
 * 添付、session.append）。塊単位だと区切りがずれてキャッシュが効かず、二重の問い合わせが LM Studio を
 * 詰まらせて `$.http.fetch` の 30 秒の上限を超えていた。見つけた値は対応表で全文に効くので、
 * 一度検査した行をもう一度検査する必要はない。
 */
export type GemmaCache = Map<string, Promise<Finding[]>>

/**
 * 形の決まらない PII（氏名、住所、生年月日、個人に紐づく ID）をローカルの Gemma で拾う。
 * 失敗は DetectorError で投げ、送るか止めるかは呼び出し側が決める。
 */
export async function detectByGemma(
  fetch: Fetch,
  config: GemmaConfig,
  cache: GemmaCache,
  text: string,
): Promise<Finding[]> {
  const known: Promise<Finding[]>[] = []
  const fresh: string[] = []
  const freshKeys = new Set<string>()
  for (const line of text.split(/(?<=\n)/)) {
    const key = keyOf(line)
    const isWorthAsking = HAS_LETTER.test(key) && !freshKeys.has(key)
    if (!isWorthAsking) continue

    const cached = cache.get(key)
    if (cached !== undefined) {
      known.push(cached)
      continue
    }
    freshKeys.add(key)
    fresh.push(line)
  }

  const limit = limiter(CONCURRENCY)
  const asked: Promise<Finding[]>[] = []
  const coveringByKey = new Map<string, Promise<Finding[]>[]>()
  for (const chunk of chunksOf(fresh)) {
    const pending = limit(() => ask(fetch, config, chunk.text))
    asked.push(pending)
    for (const key of chunk.keys) coveringByKey.set(key, [...(coveringByKey.get(key) ?? []), pending])
  }
  for (const [key, covering] of coveringByKey) {
    const answer = Promise.all(covering).then(results => results.flat())
    cache.set(key, answer)
    // 失敗した行は次回やり直せるようにキャッシュから外す
    answer.catch(() => {
      if (cache.get(key) === answer) cache.delete(key)
    })
  }

  return (await Promise.all([...known, ...asked])).flat()
}
