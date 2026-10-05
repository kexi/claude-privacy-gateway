/**
 * 伏せ字と元の値の対応表。`[token, value, category]` の並び。
 */
export type PrivacyGatewayVault = {
  entries: [token: string, value: string, category: string][]
}

declare module 'claude-code' {
  interface PluginState {
    'privacy-gateway': { vault: PrivacyGatewayVault }
  }
}
