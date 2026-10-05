import { describe, expect, test } from 'claude-code/testing'

import { detectByRegex, isMyNumber, passesLuhn } from '../hooks/detect/regex'
import { containsToken, replaceKnownValues, unmaskDeep, unmaskText } from '../hooks/mask'
import { createVault } from '../hooks/vault'

describe('mask', () => {
  test('英数字の値は単語の境界でだけ伏せ、伏せ字の内側は書き換えない', () => {
    const vault = createVault()
    vault.tokenFor('PERSON', 'kei')

    expect(replaceKnownValues('kei と keiko、/Users/kei/ghq', vault)).toBe(
      '__PII_PERSON_1__ と keiko、/Users/__PII_PERSON_1__/ghq',
    )
    expect(replaceKnownValues('__PII_PERSON_1__', vault)).toBe('__PII_PERSON_1__')
  })

  test('伏せて戻すと元の文字列に一致する（Edit の old_string が一致し続ける）', () => {
    const vault = createVault()
    vault.tokenFor('PERSON', '山田太郎')
    vault.tokenFor('EMAIL', 'taro@corp.co.jp')
    const original = '担当: 山田太郎 <taro@corp.co.jp>\n山田太郎さんへ'

    expect(unmaskText(replaceKnownValues(original, vault), vault)).toBe(original)
  })

  test('対応表にない伏せ字は、そのまま残す', () => {
    expect(unmaskText('__PII_PERSON_9__', createVault())).toBe('__PII_PERSON_9__')
  })

  test('入れ子の引数も元に戻し、伏せ字の有無を判定できる', () => {
    const vault = createVault()
    vault.tokenFor('PERSON', '山田太郎')
    const input = { edits: [{ old_string: '__PII_PERSON_1__', replace_all: false }] }

    expect(containsToken(input)).toBe(true)
    expect(unmaskDeep(input, vault)).toEqual({ edits: [{ old_string: '山田太郎', replace_all: false }] })
  })

  test('正規表現は形とチェックディジットで PII を拾い、日付や例示用アドレスは拾わない', () => {
    const findings = detectByRegex(
      [
        'mail: taro@corp.co.jp / noreply@anthropic.com / a@example.com',
        'tel: 03-1234-5678, 09012345678, date: 03-12-2026',
        'my: 1234 5678 9018, not: 1234 5678 9017',
        'card: 4242 4242 4242 4242',
        'key: AKIAIOSFODNN7EXAMPLE',
      ].join('\n'),
    )

    expect(findings).toEqual([
      { value: 'AKIAIOSFODNN7EXAMPLE', category: 'SECRET' },
      { value: 'taro@corp.co.jp', category: 'EMAIL' },
      { value: '03-1234-5678', category: 'PHONE' },
      { value: '09012345678', category: 'PHONE' },
      { value: '1234 5678 9018', category: 'MYNUMBER' },
      { value: '4242 4242 4242 4242', category: 'CARD' },
    ])
  })

  test('マイナンバーと Luhn の検算', () => {
    expect(isMyNumber('123456789018')).toBe(true)
    expect(isMyNumber('123456789017')).toBe(false)
    expect(passesLuhn('4242424242424242')).toBe(true)
    expect(passesLuhn('4242424242424241')).toBe(false)
  })
})
