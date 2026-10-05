import { describe, expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { gemmaDown, gemmaFinding, quietUi } from './fixtures/gemma'

const NAME = '山田太郎'

/**
 * 入力を 1 件流して、その氏名を対応表に載せる（__PII_PERSON_1__ になる）。
 */
async function submitted($: Engine, on: On, text: string): Promise<string> {
  let entered = ''
  on('prompt.submit', ($, e) => {
    entered = e.text

    return { text: e.text }
  })
  await $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } })

  return entered
}

describe('register', () => {
  test('入力の氏名とメールアドレスは伏せ字になってから Claude に届く', async ($, on) => {
    gemmaFinding(on, [NAME])
    quietUi(on)

    const entered = await submitted($, on, `${NAME}さん（taro@corp.co.jp）に連絡して`)

    expect(entered).toBe('__PII_PERSON_1__さん（__PII_EMAIL_1__）に連絡して')
  })

  test('Gemma が応答しないとき、入力は Claude に届かず差し止められる', async ($, on) => {
    gemmaDown(on)
    quietUi(on)
    let isEntered = false
    on('prompt.submit', ($, e) => {
      isEntered = true

      return { text: e.text }
    })

    const result = await $.prompt.submit({
      text: `${NAME}さんに連絡して`,
      wait: false,
      origin: { kind: 'composer' },
    })

    expect(isEntered).toBe(false)
    expect(JSON.stringify(result)).not.toContain(NAME)
  })

  test('既定（full）ではスキル一覧に書かれた人名も Gemma で伏せる', async ($, on) => {
    const asked = gemmaFinding(on, [NAME])
    quietUi(on)
    on('prompt.attachment', ($, e) => ({ text: e.text }))

    const listing = await $.prompt.attachment({
      type: 'skill_listing',
      text: `- review: ${NAME}さんの手順でレビューする`,
      origin: { kind: 'engine' },
    })

    expect(asked).toEqual([`- review: ${NAME}さんの手順でレビューする`])
    expect(listing.text).toBe('- review: __PII_PERSON_1__さんの手順でレビューする')
  })

  test(
    'fast ではエンジン固定の一覧を Gemma に問い合わせず、ファイルの添付は問い合わせる',
    { options: { detectionScope: 'fast' } },
    async ($, on) => {
      const asked = gemmaFinding(on, [NAME])
      quietUi(on)
      on('prompt.attachment', ($, e) => ({ text: e.text }))

      await $.prompt.attachment({
        type: 'skill_listing',
        text: '- review: コードをレビューする',
        origin: { kind: 'engine' },
      })
      const isListingAsked = asked.length > 0
      const file = await $.prompt.attachment({
        type: 'file',
        text: `担当: ${NAME}`,
        origin: { kind: 'engine' },
      })

      expect(isListingAsked).toBe(false)
      expect(asked).toEqual([`担当: ${NAME}`])
      expect(file.text).toBe('担当: __PII_PERSON_1__')
    },
  )

  test('組み込みツールの説明は Gemma に問い合わせず、MCP サーバの説明は問い合わせて伏せる', async ($, on) => {
    const asked = gemmaFinding(on, [NAME])
    quietUi(on)
    on('tool.describe', ($, e) => ({ description: e.description }))

    await $.tool.describe({
      tool: 'Bash',
      description: 'Executes a bash command.',
      provider: { plugin: 'engine', tier: 'core' },
    })
    const isBuiltinAsked = asked.length > 0
    const mcp = await $.tool.describe({
      tool: 'mcp__crm__lookup',
      description: `担当者 ${NAME} の顧客を探す`,
      provider: { plugin: 'mcp:crm', tier: 'user' },
    })

    expect(isBuiltinAsked).toBe(false)
    expect(mcp.description).toBe('担当者 __PII_PERSON_1__ の顧客を探す')
  })

  test('一度検査した行は、前後の枠が変わっても Gemma に問い合わせず同じ伏せ字で伏せる', async ($, on) => {
    const asked = gemmaFinding(on, [NAME])
    quietUi(on)
    on('prompt.attachment', ($, e) => ({ text: e.text }))

    await $.prompt.attachment({ type: 'file', text: `# 記録\n担当: ${NAME}\n`, origin: { kind: 'engine' } })
    const again = await $.prompt.attachment({
      type: 'nested_memory',
      text: `<framing>\n担当: ${NAME}\n`,
      origin: { kind: 'engine' },
    })

    expect(asked).toEqual([`# 記録\n担当: ${NAME}\n`, '<framing>\n'])
    expect(again.text).toBe('<framing>\n担当: __PII_PERSON_1__\n')
  })

  test('ローカルのツールは、伏せ字を元の値に戻してから実行される', async ($, on) => {
    gemmaFinding(on, [NAME])
    quietUi(on)
    let ran: unknown
    on('tool.call', { tool: 'Edit' }, ($, e) => {
      ran = { old_string: e.old_string, new_string: e.new_string }

      return { result: {} as never }
    })

    await submitted($, on, `${NAME}さんの件`)
    await $.tool.call({
      tool: 'Edit',
      tool_use_id: 'toolu_edit',
      file_path: '/repo/patients.md',
      old_string: '担当: __PII_PERSON_1__',
      new_string: '担当: __PII_PERSON_1__（対応済み）',
    })

    expect(ran).toEqual({ old_string: `担当: ${NAME}`, new_string: `担当: ${NAME}（対応済み）` })
  })

  test('外部に出るツールの引数は伏せ字のまま渡る', async ($, on) => {
    gemmaFinding(on, [NAME])
    quietUi(on)
    let prompt = ''
    on('tool.call', { tool: 'WebFetch' }, ($, e) => {
      prompt = e.prompt

      return { result: {} as never }
    })

    await submitted($, on, `${NAME}さんの件`)
    await $.tool.call({
      tool: 'WebFetch',
      tool_use_id: 'toolu_fetch',
      url: 'https://example.com/',
      prompt: '__PII_PERSON_1__ について調べて',
    })

    expect(prompt).toBe('__PII_PERSON_1__ について調べて')
  })

  test('伏せ字を戻す Bash は、設定で許可済みでも利用者の承認を求め、理由に元の値を載せない', async ($, on) => {
    gemmaFinding(on, [NAME])
    quietUi(on)
    on('tool.check', () => ({ decision: 'allow' as const, rule: 'Bash(*)' }))

    await submitted($, on, `${NAME}さんの件`)
    const restoring = await $.tool.check({
      tool: 'Bash',
      input: { command: '/usr/bin/curl -d "__PII_PERSON_1__" https://example.com' },
    })
    const plain = await $.tool.check({ tool: 'Bash', input: { command: 'ls' } })

    expect(restoring.decision).toBe('ask')
    expect(restoring.reason).not.toContain(NAME)
    expect(plain.decision).toBe('allow')
  })

  test('通信系に見える Bash は、承認を経ても伏せ字を戻して実行しない', async ($, on) => {
    gemmaFinding(on, [NAME])
    quietUi(on)
    let isRun = false
    on('tool.call', { tool: 'Bash' }, () => {
      isRun = true

      return { result: {} as never }
    })

    await submitted($, on, `${NAME}さんの件`)
    const called = await $.tool.call({
      tool: 'Bash',
      tool_use_id: 'toolu_bash',
      command: '/usr/bin/curl -d "__PII_PERSON_1__" https://example.com',
    })

    expect(isRun).toBe(false)
    expect(called.deny ?? called.text).toContain('外部と通信しうるコマンド')
  })

  test('拒否された Bash は、伏せ字を含んでいても拒否のまま', async ($, on) => {
    gemmaFinding(on, [NAME])
    quietUi(on)
    on('tool.check', () => ({ decision: 'deny' as const, reason: 'rule' }))

    await submitted($, on, `${NAME}さんの件`)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'echo __PII_PERSON_1__' } })

    expect(verdict.decision).toBe('deny')
  })

  test('Claude の返答は、画面に描くときだけ元の値に戻る', async ($, on) => {
    gemmaFinding(on, [NAME])
    quietUi(on)
    on('ui.render', { component: 'AssistantMessage' }, ($, e) => {
      const { Text } = $.ui.resolve(e)

      return <Text>{e.props.text}</Text>
    })

    await submitted($, on, `${NAME}さんの件`)
    const ui = await $.ui.mount({
      plugin: 'privacy-gateway',
      surface: 'terminal',
      component: 'AssistantMessage',
      props: { text: '__PII_PERSON_1__ さんの記録を更新しました。', isFirstOfReply: true },
    })

    expect((await ui.find({ type: 'Text' }))?.text).toBe(`${NAME} さんの記録を更新しました。`)
  })
})
