export type Finding = { value: string; category: string }

type Rule = {
  category: string
  pattern: RegExp
  /**
   * 形だけでは決められないものを検算で落とす（チェックディジット、桁数）。
   */
  accepts?: (match: string) => boolean
}

const PLACEHOLDER_EMAIL_DOMAIN = /(^|\.)(example\.(com|org|net)|example|invalid|test|localhost)$/i
const NOREPLY_LOCAL_PART = /^no-?reply$/i

const digitsOf = (text: string) => text.replace(/\D/g, '')

/**
 * 公開を前提にしたアドレス（例示用ドメイン、noreply）は伏せない。
 */
function isPrivateEmail(email: string): boolean {
  const [local = '', domain = ''] = email.split('@')
  const isPlaceholderDomain = PLACEHOLDER_EMAIL_DOMAIN.test(domain)
  const isNoreply = NOREPLY_LOCAL_PART.test(local) || domain.endsWith('users.noreply.github.com')

  return !isPlaceholderDomain && !isNoreply
}

/**
 * 日本の電話番号は市外局番込みで 10 桁、携帯・IP 電話は 11 桁。日付（03-12-2026 など）を落とす。
 */
function isPhoneNumber(match: string): boolean {
  const digits = digitsOf(match.replace(/^\+81/, '0'))

  return digits.length === 10 || digits.length === 11
}

/**
 * マイナンバー（個人番号）のチェックディジット検算。総務省令の計算式に従う。
 */
export function isMyNumber(match: string): boolean {
  const digits = digitsOf(match)
  if (digits.length !== 12) return false

  let sum = 0
  for (let n = 1; n <= 11; n++) {
    const p = Number(digits[11 - n])
    const q = n <= 6 ? n + 1 : n - 5
    sum += p * q
  }
  const remainder = sum % 11
  const expected = remainder <= 1 ? 0 : 11 - remainder

  return Number(digits[11]) === expected
}

/**
 * クレジットカード番号の Luhn 検算。
 */
export function passesLuhn(match: string): boolean {
  const digits = digitsOf(match)
  let sum = 0
  for (let i = 0; i < digits.length; i++) {
    const digit = Number(digits[digits.length - 1 - i])
    const isDoubled = i % 2 === 1
    const value = isDoubled ? digit * 2 : digit
    sum += value > 9 ? value - 9 : value
  }

  return sum % 10 === 0
}

const RULES: readonly Rule[] = [
  {
    category: 'SECRET',
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { category: 'SECRET', pattern: /\bAKIA[0-9A-Z]{16}\b/g },
  { category: 'SECRET', pattern: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { category: 'SECRET', pattern: /\bgithub_pat_[A-Za-z0-9_]{22,}\b/g },
  { category: 'SECRET', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { category: 'SECRET', pattern: /\bsk-(?:proj-)?[A-Za-z0-9]{20,}\b/g },
  { category: 'SECRET', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { category: 'SECRET', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  {
    category: 'EMAIL',
    pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
    accepts: isPrivateEmail,
  },
  {
    category: 'PHONE',
    pattern: /(?<![\d-])(?:\+81[- ]?\d{1,4}[- ]?\d{1,4}[- ]?\d{3,4}|0\d{1,4}-\d{1,4}-\d{3,4}|0[5789]0\d{8})(?![\d-])/g,
    accepts: isPhoneNumber,
  },
  {
    category: 'MYNUMBER',
    pattern: /(?<![\d-])\d{4}[ -]?\d{4}[ -]?\d{4}(?![\d-])/g,
    accepts: isMyNumber,
  },
  {
    category: 'CARD',
    pattern: /(?<![\d-])[3-6]\d{3}(?:[ -]?\d{2,4}){2,4}(?![\d-])/g,
    accepts: match => {
      const length = digitsOf(match).length
      const isCardLength = length >= 14 && length <= 19

      return isCardLength && passesLuhn(match)
    },
  },
  { category: 'POSTAL', pattern: /〒\s?\d{3}-?\d{4}/g },
]

/**
 * 形の決まった PII と秘密情報を正規表現で拾う。Gemma が落ちていても必ず効く層。
 */
export function detectByRegex(text: string): Finding[] {
  const findings: Finding[] = []
  for (const rule of RULES) {
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0]
      const isAccepted = rule.accepts?.(value) ?? true
      if (!isAccepted) continue

      findings.push({ value, category: rule.category })
    }
  }

  return findings
}
