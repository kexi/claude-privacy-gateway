/**
 * 伏せ字を元の値に戻してから実行してよいツール。どれも手元のファイルやプロセスに作用し、
 * 引数そのものを外部サービスへ送らない。
 *
 * Why not 全ツールで戻す: WebFetch / WebSearch / MCP（SaaS 連携）は引数が外部に出るので、
 * 戻すとせっかく伏せた値をそのまま第三者に渡してしまう。これらは伏せ字のまま実行させる。
 */
const LOCAL_TOOLS = new Set([
  'Read',
  'Write',
  'Edit',
  'MultiEdit',
  'NotebookEdit',
  'Glob',
  'Grep',
  'Bash',
])

export function isLocalTool(tool: string): boolean {
  return LOCAL_TOOLS.has(tool)
}

/**
 * 伏せ字を戻して実行する前に、利用者の承認を求めるツール。Bash は何でも実行でき、外部へも送れる。
 *
 * Why not コマンド名の拒否リストだけで守る: `python3 -c '...urllib...'`、`node -e 'fetch(...)'` など
 * 書き方はいくらでもあり、名前ではすり抜けを防げない（2026-10-06 のセキュリティレビューの指摘）。
 * 名前の拒否リスト（下の NETWORK_COMMAND）は、承認が人の目を通らない場合の最低限の止めとして併用する。
 */
const APPROVAL_TOOLS = new Set(['Bash'])

export function needsApproval(tool: string): boolean {
  return APPROVAL_TOOLS.has(tool)
}

/**
 * 通信に使われることの多いコマンド。`/usr/bin/curl` のようなパス指定も拾う。
 *
 * 承認（`tool.check` の ask）を下すのは「モードごとの判定者」で、オートモードでは判定器（Claude）が許可しうる。
 * 人の目を通らずに伏せ字が戻って外へ出ることを防ぐため、伏せ字を戻した Bash がこれに当たれば承認に関わらず拒否する。
 * 名前で見るだけの最善努力の網で、主な防御は承認のほう（`python3 -c` などはここでは止まらない）。
 */
const NETWORK_COMMAND =
  /(^|[\s;&|(`$/])(curl|wget|http|https|xh|gh|ssh|scp|sftp|rsync|nc|ncat|socat|telnet|ftp|aws|gcloud|az|mail|sendmail)(?=\s|$)|\bgit\s+(push|send-email)\b|\b(npm|pnpm|yarn|bun)\s+publish\b|\bdocker\s+push\b/

export function isNetworkBoundCommand(command: string): boolean {
  return NETWORK_COMMAND.test(command)
}

export const NETWORK_DENIAL =
  'privacy-gateway: 外部と通信しうるコマンドに伏せ字（__PII_…__）が含まれているため、元の値に戻して実行しませんでした。' +
  '伏せ字を含まない形で実行するか、ユーザー自身に実行を依頼してください。'

/**
 * 承認ダイアログに出す理由。
 *
 * Why not 戻した後のコマンドをそのまま見せる: この理由はオートモードの判定器（Claude）にも渡りうるので、
 * 元の値を入れると Claude に PII が届く。伏せ字のまま、戻すことだけを知らせる。
 */
export const APPROVAL_REASON =
  'privacy-gateway: このコマンドに含まれる伏せ字（__PII_…__）を元の値に戻して実行します。' +
  '値が外部に送られないことを確かめてから許可してください。'
