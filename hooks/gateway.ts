import type { PluginOptions } from 'claude-code'

import type { PrivacyGatewayVault } from '../types'
import { detectByGemma, type Fetch, type GemmaCache, type GemmaConfig } from './detect/gemma'
import { detectByRegex, type Finding } from './detect/regex'
import { replaceKnownValues } from './mask'
import type { ImagePolicy } from './message'
import { createVault, mergeSnapshots, type Vault } from './vault'

/**
 * hook が `$` から作って渡す入出力。`$` は `$.noun.event(...)` の形でしか綴れず、
 * 関数の引数にできないため、必要な操作だけをクロージャにして受け取る。
 */
export type Port = {
  fetch: Fetch
  load: () => Promise<PrivacyGatewayVault>
  save: (change: (held: PrivacyGatewayVault) => PrivacyGatewayVault) => Promise<unknown>
  log: (text: string) => void
  status: (text: string) => void
  /**
   * debug ログに 1 行の JSON を書く。中身（原文・伏せ字の対応）は決して載せず、種類・量・時間だけを書く。
   */
  trace: (fields: Record<string, string | number | boolean>) => void
}

export type Settings = {
  gemma: GemmaConfig
  /**
   * Gemma が失敗したとき送信を止めるか（true）、正規表現だけで伏せて送るか（false）。
   */
  isFailClosed: boolean
  images: ImagePolicy
  /**
   * `full`: エンジン固定の文章（スキル一覧、システムプロンプトの固定セクションなど）も Gemma で検査する。
   * `fast`: それらは正規表現と既知の値の置き換えだけにする。起動直後の検査が `$.http.fetch` の 30 秒の
   * 上限に収まりやすいが、利用者の書いたスキルの説明などに入った人名は通り抜ける。
   */
  scope: DetectionScope
  /**
   * `off`: 伏せ字を含む Bash は戻さずに拒否する。`with-approval`: 毎回の承認を経て戻す。
   */
  bashRestore: BashRestore
}

export type DetectionScope = 'full' | 'fast'

export type BashRestore = 'off' | 'with-approval'

export function settingsOf(options: PluginOptions): Settings {
  const stringOf = (key: string, fallback: string) => {
    const value = options[key]
    const isSet = typeof value === 'string' && value !== ''

    return isSet ? value : fallback
  }

  return {
    gemma: {
      url: stringOf('gemmaUrl', 'http://127.0.0.1:1234/v1/chat/completions'),
      model: stringOf('gemmaModel', 'gemma-4-12b-it-mlx-bench@6bit'),
    },
    isFailClosed: stringOf('onDetectorError', 'block') === 'block',
    images: stringOf('images', 'drop') === 'pass' ? 'pass' : 'drop',
    scope: stringOf('detectionScope', 'full') === 'fast' ? 'fast' : 'full',
    bashRestore: stringOf('bashRestore', 'off') === 'with-approval' ? 'with-approval' : 'off',
  }
}

export type Gateway = {
  vault: Vault
  /**
   * 保存済みの対応表を読み込む。伏せ字を割り当てる前に必ず待つ
   * （読み込み前に割り当てると、既に Claude に渡した番号と衝突する）。
   */
  ready: (load: Port['load']) => Promise<void>
  /**
   * テキストを伏せ字にする。新しく見つけた値は対応表に足して保存する。
   */
  mask: (port: Port, text: string, scope?: MaskScope) => Promise<string>
}

/**
 * `regex` では Gemma に問い合わせず、正規表現と既知の値の置き換えだけで伏せる。
 */
export type MaskDepth = 'full' | 'regex'

/**
 * どこから呼ばれた検査か（`site` は trace に載せる名前）と、検査の深さ。
 */
export type MaskScope = { site: string; depth?: MaskDepth }

export function createGateway(settings: Settings): Gateway {
  const vault = createVault()
  const cache: GemmaCache = new Map()
  let hydrating: Promise<void> | undefined
  let isFailureLogged = false

  const ready = (load: Port['load']): Promise<void> => {
    const pending =
      hydrating ??
      load().then(
        saved => vault.absorb(saved),
        (error: unknown) => {
          // 読み込みに失敗したら次の hook でやり直す
          hydrating = undefined
          throw error
        },
      )
    hydrating = pending

    return pending
  }

  const detectWithGemma = async (port: Port, text: string): Promise<Finding[]> => {
    try {
      return await detectByGemma(port.fetch, settings.gemma, cache, text)
    } catch (error) {
      if (settings.isFailClosed) throw error

      if (!isFailureLogged) {
        isFailureLogged = true
        port.log(`privacy-gateway: Gemma で検出できないため正規表現だけで伏せています（${String(error)}）`)
      }

      return []
    }
  }

  const mask = async (port: Port, text: string, scope: MaskScope = { site: 'direct' }) => {
    await ready(port.load)
    const isBlank = text.trim() === ''
    if (isBlank) return text

    const depth = scope.depth ?? 'full'
    const startedAt = Date.now()
    const before = vault.size()
    const byGemma = depth === 'full' ? await detectWithGemma(port, text) : []
    const findings = [...detectByRegex(text), ...byGemma]
    for (const finding of findings) vault.tokenFor(finding.category, finding.value)

    const added = vault.size() - before
    if (added > 0) {
      await port.save(held => mergeSnapshots(held, vault.snapshot()))
      port.status(`privacy-gateway: ${vault.size()} 件を伏せ字で送信中`)
    }
    port.trace({ event: 'mask', site: scope.site, depth, chars: text.length, added, ms: Date.now() - startedAt })

    return replaceKnownValues(text, vault)
  }

  return { vault, ready, mask }
}
