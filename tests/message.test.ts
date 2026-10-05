import { describe, expect, test } from 'claude-code/testing'

import { createGateway, settingsOf } from '../hooks/gateway'
import { BLOCKED_TEXT, blockedMessage, maskMessage } from '../hooks/message'
import { portFinding } from './fixtures/gemma'

const NAME = '山田太郎'

const row = (content: { type: string; [field: string]: unknown }[]) => ({
  type: 'user' as const,
  role: 'user' as const,
  content,
})

describe('message', () => {
  test('ツール結果と本文のテキストは、同じ値なら同じ伏せ字で置き換わる', async () => {
    const gateway = createGateway(settingsOf({}))
    const port = portFinding([NAME])

    const masked = await maskMessage(
      row([
        { type: 'text', text: `${NAME}さんの記録` },
        { type: 'tool_result', tool_use_id: 'toolu_read', content: `担当: ${NAME}\n電話: 090-1234-5678` },
      ]),
      { mask: text => gateway.mask(port, text), images: 'drop', onUnmasked: () => {} },
    )

    expect(masked.content).toEqual([
      { type: 'text', text: '__PII_PERSON_1__さんの記録' },
      {
        type: 'tool_result',
        tool_use_id: 'toolu_read',
        content: '担当: __PII_PERSON_1__\n電話: __PII_PHONE_1__',
      },
    ])
  })

  test('一度覚えた値は、Gemma が見落とした文でも伏せられる', async () => {
    const gateway = createGateway(settingsOf({}))

    await gateway.mask(portFinding([NAME]), `${NAME}さん`)
    const masked = await gateway.mask(portFinding([]), `再掲: ${NAME}`)

    expect(masked).toBe('再掲: __PII_PERSON_1__')
  })

  test('伏せ字にできない画像は、既定では除外される', async () => {
    const gateway = createGateway(settingsOf({}))

    const masked = await maskMessage(
      row([{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAA' } }]),
      { mask: text => gateway.mask(portFinding([]), text), images: 'drop', onUnmasked: () => {} },
    )

    expect(JSON.stringify(masked)).not.toContain('AAAA')
  })

  test('tool_result の中の知らない種類は伏せてから渡し、最上位の知らない種類は伏せられないことを知らせる', async () => {
    const gateway = createGateway(settingsOf({}))
    const port = portFinding([NAME])
    const unmasked: string[] = []

    const masked = await maskMessage(
      row([
        {
          type: 'tool_result',
          tool_use_id: 'toolu_search',
          content: [{ type: 'search_result', title: `${NAME}さんの記録`, source: 'local' }],
        },
        { type: 'container_upload', file_id: 'file_1' },
      ]),
      { mask: text => gateway.mask(port, text), images: 'drop', onUnmasked: type => unmasked.push(type) },
    )

    expect(JSON.stringify(masked)).not.toContain(NAME)
    expect(JSON.stringify(masked)).toContain('__PII_PERSON_1__')
    expect(unmasked).toEqual(['container_upload'])
  })

  test('検出に失敗した行は、原文を残さず tool_result の対応だけ保つ', () => {
    const blocked = blockedMessage(
      row([
        { type: 'text', text: `${NAME}さん` },
        { type: 'tool_result', tool_use_id: 'toolu_read', content: `担当: ${NAME}` },
      ]),
    )

    expect(blocked.content).toEqual([
      { type: 'text', text: BLOCKED_TEXT },
      { type: 'tool_result', tool_use_id: 'toolu_read', content: BLOCKED_TEXT, is_error: true },
    ])
  })

  test('Gemma が止まっていれば block 設定では例外になり、regex-only なら正規表現で伏せる', async () => {
    const blocking = createGateway(settingsOf({}))
    const lenient = createGateway(settingsOf({ onDetectorError: 'regex-only' }))

    const failed = await blocking.mask(portFinding('down'), '電話: 090-1234-5678').then(
      () => 'sent',
      () => 'blocked',
    )
    const masked = await lenient.mask(portFinding('down'), '電話: 090-1234-5678')

    expect(failed).toBe('blocked')
    expect(masked).toBe('電話: __PII_PHONE_1__')
  })

  test('30 秒の打ち切りと 5xx は送り直し、続けて失敗し尽くしたら例外にする', async () => {
    const flaky = portFinding([NAME])
    let cut = 2
    const answering = flaky.fetch
    flaky.fetch = async (url, init) => {
      cut--
      if (cut === 1) throw new Error('HooksError: fetch timed out')
      if (cut === 0) return { status: 500, ok: false, headers: {}, text: 'Impacting Interactivity' }
      return answering(url, init)
    }
    const dead = portFinding([NAME])
    dead.fetch = async () => {
      throw new Error('HooksError: fetch timed out')
    }

    const masked = await createGateway(settingsOf({})).mask(flaky, `${NAME}さん`)
    const failed = await createGateway(settingsOf({})).mask(dead, `${NAME}さん`).then(
      () => 'sent',
      () => 'blocked',
    )

    expect(masked).toBe('__PII_PERSON_1__さん')
    expect(failed).toBe('blocked')
  })

  test('保存した対応表を読み込んだ後は、続きの番号から割り当てる', async () => {
    const port = portFinding(['佐藤花子'])
    await port.save(() => ({ entries: [['__PII_PERSON_1__', NAME, 'PERSON']] }))
    const gateway = createGateway(settingsOf({}))

    const masked = await gateway.mask(port, `佐藤花子さんと${NAME}さん`)

    expect(masked).toBe('__PII_PERSON_2__さんと__PII_PERSON_1__さん')
  })
})
