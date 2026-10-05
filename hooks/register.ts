import { atom, read, update } from 'claude-code'
import type { Register } from 'claude-code'

import { APPROVAL_REASON, NETWORK_DENIAL, isLocalTool, isNetworkBoundCommand, needsApproval } from './egress'
import { createGateway, settingsOf, type DetectionScope, type MaskDepth, type Port } from './gateway'
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
 * `fast` でも Gemma に通すシステムプロンプトのセクション。auto memory は利用者について書かれうる。
 * 残りはエンジン固定の説明文なので、`fast` では正規表現と既知の値の置き換えだけにする
 * （20 前後のセクションを毎回問い合わせると、最初の応答まで数分待つことになる。E2E で約 3 分）。
 */
const USER_DATA_SECTIONS = new Set(['memory'])

/**
 * エンジンが自前で書く一覧・定型文の添付。`fast` ではこれらを Gemma に通さない。
 *
 * Why not 逆に「利用者のデータを含む種類だけ Gemma に通す」: 種類名はビルドごとに増減し、未知の種類
 * （IDE の選択範囲、MCP リソースなど）に利用者のデータが入りうる。未知の種類は Gemma に通す側に倒す。
 * Why not 既定（`full`）でも省く: スキル一覧や MCP の説明には利用者や第三者の書いた文が入り、
 * 人名が通り抜ける（2026-10-06 のセキュリティレビューの指摘）。省くのは利用者が `fast` を選んだときだけ。
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

const OMITTED_DESCRIPTION = '[privacy-gateway] このツールの説明は PII を検査できなかったため省略しました。'

/**
 * 検出に失敗して差し止めたことを記す debug ログの 1 行。失敗の文面は Gemma の出力を含みうるので載せない。
 */
function blockedLine(site: string, kind: string | undefined): string {
  return JSON.stringify({ plugin: 'privacy-gateway', event: 'blocked', site, kind: kind ?? 'unknown' })
}

/**
 * 添付の検査の深さ。`fast` のときだけ、エンジン自身が書いた一覧・定型文を正規表現だけにする。
 */
function attachmentDepth(scope: DetectionScope, type: string, isByEngine: boolean): MaskDepth {
  const isEngineProse = isByEngine && ENGINE_PROSE_ATTACHMENTS.has(type)

  return scope === 'fast' && isEngineProse ? 'regex' : 'full'
}

/**
 * システムプロンプトのセクションの検査の深さ。
 */
function sectionDepth(scope: DetectionScope, name: string): MaskDepth {
  return scope === 'fast' && !USER_DATA_SECTIONS.has(name) ? 'regex' : 'full'
}

/**
 * Claude に届くものは伏せ字にし、戻すのは「手元で完結するツールの実行直前」と「画面表示」だけにする。
 *
 * 伏せる: prompt.submit（入力）/ session.append（会話に積まれる全行）/ prompt.attachment・
 *   prompt.context・prompt.section・tool.describe（リクエストごとに組み立てられる添付・CLAUDE.md・
 *   システムプロンプト・ツールの説明）
 * 戻す: tool.call（ローカルツールの引数。Bash は tool.check で承認を求めてから）/
 *   ui.render（表示だけ。保存される行は伏せ字のまま）
 *
 * 伏せる側の hook には必ず .catch を付ける。付けないと失敗時にエンジンが next(e) を代行し、
 * 原文がそのまま Claude に届く（fail-open）ため。
 */

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
    const isEngineAttachment = e.door === 'attachment' && e.origin.kind === 'engine'
    const site = `session.append:${e.door}:${e.message.name ?? e.message.type}`
    const depth = attachmentDepth(settings.scope, e.message.name ?? '', isEngineAttachment)
    const message = await maskMessage(e.message, {
      mask: text => gateway.mask(port, text, { site, depth }),
      images: settings.images,
      onUnmasked: type => port.trace({ event: 'unmasked-block', site, type }),
    })

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

    const depth = attachmentDepth(settings.scope, e.type, e.origin.kind === 'engine')

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

    const depth = sectionDepth(settings.scope, e.name)

    return { text: await gateway.mask(port, section.text, { site: `section:${e.name}`, depth }) }
  }).catch(($, e, next) => {
    $.ui.log(blockedLine(`section:${e.name}`, next.error?.kind), { to: 'debug' })

    return { text: null }
  })

  on('tool.describe', async ($, e, next) => {
    // $ は引数にできないので、この hook の $ を包んだ入出力をその場で作る
    const port: Port = {
      fetch: (url, init) => $.http.fetch(url, init),
      load: () => read($, VAULT),
      save: change => update($, VAULT, change),
      log: text => $.ui.log(text),
      status: text => $.ui.status(text),
      trace: fields => $.ui.log(JSON.stringify({ plugin: 'privacy-gateway', ...fields }), { to: 'debug' }),
    }
    const described = await next(e)
    // 組み込みツールの説明はエンジン固定の文章。MCP サーバなど外から来た説明だけを Gemma に通す
    const isByEngine = e.provider.plugin === 'engine'
    const depth = isByEngine || settings.scope === 'fast' ? 'regex' : 'full'
    const site = `describe:${e.tool}`

    return { ...described, description: await gateway.mask(port, described.description, { site, depth }) }
  }).catch(($, e, next) => {
    $.ui.log(blockedLine(`describe:${e.tool}`, next.error?.kind), { to: 'debug' })

    return { description: OMITTED_DESCRIPTION }
  })

  // ---- 手元で実行する直前にだけ戻す ----

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    const isRestoringCommand = needsApproval(e.tool) && containsToken(e.input)
    const isDenied = verdict.decision === 'deny'
    if (!isRestoringCommand || isDenied) return verdict

    // 設定で許可済みのコマンドでも、元の値に戻して実行するなら毎回確かめる
    return { decision: 'ask', reason: APPROVAL_REASON }
  }).catch(($, e, next) => {
    const isRestoringCommand = needsApproval(e.tool) && containsToken(e.input)
    if (!isRestoringCommand) return next(e)

    return { decision: 'ask', reason: APPROVAL_REASON }
  })

  on('tool.call', async ($, e, next) => {
    await gateway.ready(() => read($, VAULT))
    const isRestorable = isLocalTool(e.tool) && containsToken(e)
    if (!isRestorable) return next(e)

    const restored = unmaskDeep(e, gateway.vault)
    // 承認はオートモードの判定器が下すこともあるので、通信系に見えるコマンドには承認に関わらず戻さない
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
