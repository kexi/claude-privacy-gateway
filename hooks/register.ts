import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { NETWORK_DENIAL, isLocalTool, isNetworkBoundCommand } from './egress'
import { createGateway, settingsOf, type Port } from './gateway'
import { containsToken, unmaskDeep, unmaskText } from './mask'
import { BLOCKED_TEXT, blockedMessage, maskMessage } from './message'

/**
 * 対応表はセッションの状態に置く。モジュール変数だけだと hot reload で消え、
 * それ以前に渡した伏せ字を戻せなくなるため。
 *
 * read / update に渡す参照は、エンジンの検査が読めるよう呼び出すファイル自身の const で定義する。
 */
const VAULT = atom({ plugin: 'privacy-gateway', key: 'vault' } as const, { entries: [] })

/**
 * Gemma にも通すシステムプロンプトのセクション。auto memory は利用者について書かれうる。
 *
 * Why not 全セクションを Gemma に通す: 残りはエンジン固定の説明文で利用者のデータを含まず、
 * 20 前後のセクションを毎回問い合わせると最初の応答まで数分待つことになる（E2E で約 3 分）。
 * 固定文にも既知の値と正規表現の置き換えは掛けるので、混入した値は伏せられる。
 */
const USER_DATA_SECTIONS = new Set(['memory'])

/**
 * エンジンが自前で書く一覧・定型文の添付。利用者のデータを含まないので Gemma に通さない。
 *
 * Why not 逆に「利用者のデータを含む種類だけ Gemma に通す」: 種類名はビルドごとに増減し、未知の種類
 * （IDE の選択範囲、MCP リソースなど）に利用者のデータが入りうる。未知の種類は Gemma に通す側に倒す。
 * Why not 全部 Gemma に通す: 起動直後に大きな一覧が Gemma の待ち行列を埋め、CLAUDE.md の検査が
 * 30 秒の上限を超えて差し止められていた（E2E で先頭メッセージの 11 ブロック中 9 ブロックが消えた）。
 */
const ENGINE_PROSE_ATTACHMENTS = new Set([
  // 2.1.289 の E2E で観測した、エンジン固定の一覧と定型文
  'skill_listing',
  'agent_listing_delta',
  'deferred_tools_delta',
  'mcp_instructions_delta',
  'remote_session_change',
  'language',
  'model',
  'date',
  'total_tokens_reminder',
  'todo_reminder',
  'plan_mode',
  'plan_mode_exit',
  'plan_mode_reentry',
  'auto_mode',
  'auto_mode_exit',
])

const RESTORE_FAILED = 'privacy-gateway: 伏せ字を元の値に戻せなかったため、ツールを実行しませんでした。'

/**
 * Claude に届くものは伏せ字にし、戻すのは「手元で完結するツールの実行直前」と「画面表示」だけにする。
 *
 * 伏せる: prompt.submit（入力）/ session.append（会話に積まれる全行）/ prompt.attachment・
 *   prompt.context・prompt.section（リクエストごとに組み立てられる添付・CLAUDE.md・システムプロンプト）
 * 戻す: tool.call（ローカルツールの引数）/ ui.render（表示だけ。保存される行は伏せ字のまま）
 *
 * 伏せる側の hook には必ず .catch を付ける。付けないと失敗時にエンジンが next(e) を代行し、
 * 原文がそのまま Claude に届く（fail-open）ため。
 */
/**
 * 検出に失敗して差し止めたことを記す debug ログの 1 行。失敗の文面は Gemma の出力を含みうるので載せない。
 */
function blockedLine(site: string, kind: string | undefined): string {
  return JSON.stringify({ plugin: 'privacy-gateway', event: 'blocked', site, kind: kind ?? 'unknown' })
}

export const register: Register = (on, options) => {
  const settings = settingsOf(options)
  const gateway = createGateway(settings)

  on('session.start', async ($, e, next) => {
    await gateway.ready(() => read($, VAULT))

    return next(e)
  })

  // ---- Claude に届く前に伏せる ----

  on('prompt.submit', async ($, e, next) => {
    // $ は引数にできないので、この hook の $ を包んだ入出力をその場で作る
    const port: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
      load: () => read($, VAULT),
      save: change => update($, VAULT, change),
      log: text => $.ui.log(text),
      status: text => $.ui.status(text),
      trace: fields => $.ui.log(JSON.stringify({ plugin: 'privacy-gateway', ...fields }), { to: 'debug' }),
    }
    const text = await gateway.mask(port, e.text, { site: 'prompt.submit' })
    const context =
      e.context === undefined
        ? undefined
        : await Promise.all(e.context.map(entry => gateway.mask(port, entry, { site: 'prompt.submit:context' })))

    return next({ ...e, text, ...(context !== undefined && { context }) })
  }).catch(($, e, next) => {
    $.ui.log(blockedLine('prompt.submit', next.error?.kind), { to: 'debug' })

    return { drop: BLOCKED_TEXT }
  })

  on('session.append', async ($, e, next) => {
    const isSentToModel = e.message.role !== undefined
    const isModelOutput = e.door === 'response'
    if (!isSentToModel || isModelOutput) return next(e)

    // $ は引数にできないので、この hook の $ を包んだ入出力をその場で作る
    const port: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
      load: () => read($, VAULT),
      save: change => update($, VAULT, change),
      log: text => $.ui.log(text),
      status: text => $.ui.status(text),
      trace: fields => $.ui.log(JSON.stringify({ plugin: 'privacy-gateway', ...fields }), { to: 'debug' }),
    }
    const isEngineProse =
      e.door === 'attachment' &&
      e.origin.kind === 'engine' &&
      ENGINE_PROSE_ATTACHMENTS.has(e.message.name ?? '')
    const scope = {
      site: `session.append:${e.door}:${e.message.name ?? e.message.type}`,
      depth: isEngineProse ? ('regex' as const) : ('full' as const),
    }
    const message = await maskMessage(e.message, text => gateway.mask(port, text, scope), settings.images)

    return next({ ...e, message })
  }).catch(($, e, next) => {
    const isSentToModel = e.message.role !== undefined
    const isModelOutput = e.door === 'response'
    if (!isSentToModel || isModelOutput) return next(e)

    $.ui.log(blockedLine(`session.append:${e.door}`, next.error?.kind), { to: 'debug' })

    return next({ ...e, message: blockedMessage(e.message) })
  })

  on('prompt.attachment', async ($, e, next) => {
    // $ は引数にできないので、この hook の $ を包んだ入出力をその場で作る
    const port: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
      load: () => read($, VAULT),
      save: change => update($, VAULT, change),
      log: text => $.ui.log(text),
      status: text => $.ui.status(text),
      trace: fields => $.ui.log(JSON.stringify({ plugin: 'privacy-gateway', ...fields }), { to: 'debug' }),
    }
    const attached = await next(e)
    if (attached.text === null) return attached

    const isEngineProse = e.origin.kind === 'engine' && ENGINE_PROSE_ATTACHMENTS.has(e.type)
    const depth = isEngineProse ? 'regex' : 'full'

    return { text: await gateway.mask(port, attached.text, { site: `attachment:${e.type}`, depth }) }
  }).catch(($, e, next) => {
    $.ui.log(blockedLine(`attachment:${e.type}`, next.error?.kind), { to: 'debug' })

    return { text: null }
  })

  on('prompt.context', async ($, e, next) => {
    // $ は引数にできないので、この hook の $ を包んだ入出力をその場で作る
    const port: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
      load: () => read($, VAULT),
      save: change => update($, VAULT, change),
      log: text => $.ui.log(text),
      status: text => $.ui.status(text),
      trace: fields => $.ui.log(JSON.stringify({ plugin: 'privacy-gateway', ...fields }), { to: 'debug' }),
    }
    const context = await next(e)
    const blocks = await Promise.all(
      context.blocks.map(async block => ({
        ...block,
        text: await gateway.mask(port, block.text, { site: `context:${block.name}` }),
      })),
    )

    return { ...context, blocks }
  }).catch(($, e, next) => {
    $.ui.log(blockedLine('prompt.context', next.error?.kind), { to: 'debug' })

    return { blocks: [] }
  })

  on('prompt.section', async ($, e, next) => {
    // $ は引数にできないので、この hook の $ を包んだ入出力をその場で作る
    const port: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
      load: () => read($, VAULT),
      save: change => update($, VAULT, change),
      log: text => $.ui.log(text),
      status: text => $.ui.status(text),
      trace: fields => $.ui.log(JSON.stringify({ plugin: 'privacy-gateway', ...fields }), { to: 'debug' }),
    }
    const section = await next(e)
    if (section.text === null) return section

    const depth = USER_DATA_SECTIONS.has(e.name) ? 'full' : 'regex'

    return { text: await gateway.mask(port, section.text, { site: `section:${e.name}`, depth }) }
  }).catch(($, e, next) => {
    $.ui.log(blockedLine(`section:${e.name}`, next.error?.kind), { to: 'debug' })

    return { text: null }
  })

  // ---- 手元で実行する直前にだけ戻す ----

  on('tool.call', async ($, e, next) => {
    await gateway.ready(() => read($, VAULT))
    const isRestorable = isLocalTool(e.tool) && containsToken(e)
    if (!isRestorable) return next(e)

    const restored = unmaskDeep(e, gateway.vault)
    const isNetworkBash = restored.tool === 'Bash' && isNetworkBoundCommand(restored.command)
    if (isNetworkBash) return { deny: NETWORK_DENIAL }

    return next(restored)
  }).catch(() => ({ deny: RESTORE_FAILED }))

  // ---- 画面に描くときだけ戻す（保存・送信される行は伏せ字のまま） ----

  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    await gateway.ready(() => read($, VAULT))
    const text = unmaskText(e.props.text, gateway.vault)
    if (text === e.props.text) return next(e)

    return next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'UserMessage' }, async ($, e, next) => {
    await gateway.ready(() => read($, VAULT))
    const text = unmaskText(e.props.text, gateway.vault)
    if (text === e.props.text) return next(e)

    return next({ ...e, props: { ...e.props, text } })
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    await gateway.ready(() => read($, VAULT))
    if (!containsToken(e.props.input) && !containsToken(e.props.output)) return next(e)

    const input = unmaskDeep(e.props.input, gateway.vault)
    const hasOutput = 'output' in e.props
    const props = hasOutput
      ? { ...e.props, input, output: unmaskDeep(e.props.output, gateway.vault) }
      : { ...e.props, input }

    return next({ ...e, props })
  })

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    await gateway.ready(() => read($, VAULT))
    if (!containsToken(e.props.output)) return next(e)

    return next({ ...e, props: { ...e.props, output: unmaskDeep(e.props.output, gateway.vault) } })
  })
}
