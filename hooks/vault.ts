import type { PrivacyGatewayVault } from '../types'

/**
 * 伏せ字の書式。`__PII_PERSON_1__` のように ASCII の識別子として閉じた形にする。
 *
 * Why not `⟦PERSON_1⟧` や `[PERSON_1]`: 前者は非 ASCII のためシェルやエディタ経由で
 * 揺れやすく、後者は Markdown のリンク記法や配列リテラルと見分けがつかない。
 * 識別子の形なら Claude はコード中でも文中でも一字一句そのまま書き戻す。
 */
export const TOKEN_SOURCE = '__PII_[A-Z]+_\\d+__'

const TOKEN_EXACT = new RegExp(`^${TOKEN_SOURCE}$`)

export type Vault = {
  /**
   * 値に対応する伏せ字を返す。初めての値なら種類ごとの連番で新しく割り当てる。
   */
  tokenFor: (category: string, value: string) => string
  tokenOf: (value: string) => string | undefined
  valueOf: (token: string) => string | undefined
  /**
   * 既知の値を長い順に返す。短い値が長い値の一部を先に置き換えないようにするため。
   */
  knownValues: () => readonly string[]
  size: () => number
  snapshot: () => PrivacyGatewayVault
  /**
   * 保存済みの対応表を取り込む。連番は取り込んだ伏せ字の続きから振る。
   */
  absorb: (saved: PrivacyGatewayVault) => void
}

export function isToken(text: string): boolean {
  return TOKEN_EXACT.test(text)
}

export function createVault(): Vault {
  const byValue = new Map<string, string>()
  const byToken = new Map<string, { value: string; category: string }>()
  const counters = new Map<string, number>()
  let sortedValues: readonly string[] | undefined

  const remember = (token: string, value: string, category: string) => {
    byValue.set(value, token)
    byToken.set(token, { value, category })
    sortedValues = undefined
  }

  const tokenFor = (category: string, value: string) => {
    const known = byValue.get(value)
    if (known !== undefined) return known

    const next = (counters.get(category) ?? 0) + 1
    counters.set(category, next)
    const token = `__PII_${category}_${next}__`
    remember(token, value, category)

    return token
  }

  const absorb = (saved: PrivacyGatewayVault) => {
    for (const [token, value, category] of saved.entries) {
      const isAlreadyKnown = byToken.has(token)
      if (isAlreadyKnown) continue

      remember(token, value, category)
      const serial = Number(token.match(/_(\d+)__$/)?.[1] ?? 0)
      counters.set(category, Math.max(counters.get(category) ?? 0, serial))
    }
  }

  return {
    tokenFor,
    tokenOf: value => byValue.get(value),
    valueOf: token => byToken.get(token)?.value,
    knownValues: () => {
      sortedValues ??= [...byValue.keys()].sort((a, b) => b.length - a.length)
      return sortedValues
    },
    size: () => byToken.size,
    snapshot: () => ({
      entries: [...byToken].map(([token, { value, category }]) => [token, value, category]),
    }),
    absorb,
  }
}

/**
 * 2 つの対応表を伏せ字単位で合わせる。並行して保存しても割り当てを失わないため。
 */
export function mergeSnapshots(
  held: PrivacyGatewayVault,
  mine: PrivacyGatewayVault,
): PrivacyGatewayVault {
  const tokens = new Set(held.entries.map(([token]) => token))
  const added = mine.entries.filter(([token]) => !tokens.has(token))

  return { entries: [...held.entries, ...added] }
}
