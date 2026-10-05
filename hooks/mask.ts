import { TOKEN_SOURCE, isToken, type Vault } from './vault'

const TOKEN_GLOBAL = new RegExp(TOKEN_SOURCE, 'g')

const ASCII_WORD = /[A-Za-z0-9_]/

/**
 * 正規表現の構文文字だけを退避する（u フラグでは `-` などの余計な退避が構文エラーになる）。
 */
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')

/**
 * 英数字で始まる・終わる値は単語の境界でだけ置き換える（`kei` で `keiko` を壊さない）。
 * かな漢字の値には単語境界がないので部分一致で置き換える。
 */
function patternOf(value: string): string {
  const head = ASCII_WORD.test(value[0] ?? '') ? '(?<![A-Za-z0-9_])' : ''
  const tail = ASCII_WORD.test(value[value.length - 1] ?? '') ? '(?![A-Za-z0-9_])' : ''

  return `${head}${escape(value)}${tail}`
}

/**
 * 既知の値をすべて伏せ字に置き換える。いま検出されなかった値も、一度覚えた値なら必ず伏せる。
 *
 * 伏せ字そのものを選択肢の先頭に置き、既存の伏せ字の内側が別の値として置き換わらないようにする。
 */
export function replaceKnownValues(text: string, vault: Vault): string {
  const values = vault.knownValues()
  if (values.length === 0) return text

  const pattern = new RegExp([TOKEN_SOURCE, ...values.map(patternOf)].join('|'), 'gu')

  return text.replace(pattern, match => (isToken(match) ? match : (vault.tokenOf(match) ?? match)))
}

/**
 * 伏せ字を元の値に戻す。対応表にない伏せ字（Claude が作った番号など）はそのまま残す。
 */
export function unmaskText(text: string, vault: Vault): string {
  return text.replace(TOKEN_GLOBAL, token => vault.valueOf(token) ?? token)
}

/**
 * オブジェクトや配列の中の文字列をすべて元に戻す。ツールの引数や表示用の props に使う。
 */
export function unmaskDeep<T>(value: T, vault: Vault): T {
  if (typeof value === 'string') return unmaskText(value, vault) as T
  if (Array.isArray(value)) return value.map(item => unmaskDeep(item, vault)) as T

  const isRecord = typeof value === 'object' && value !== null
  if (!isRecord) return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [key, unmaskDeep(item, vault)]),
  ) as T
}

/**
 * 値の中に伏せ字が 1 つでもあるか。
 */
export function containsToken(value: unknown): boolean {
  if (typeof value === 'string') return new RegExp(TOKEN_SOURCE).test(value)
  if (Array.isArray(value)) return value.some(containsToken)

  const isRecord = typeof value === 'object' && value !== null
  if (!isRecord) return false

  return Object.values(value).some(containsToken)
}
