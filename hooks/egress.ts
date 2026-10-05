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
 * Why not コマンド名で外部通信を判定して拒否する: `/usr/bin/curl`、`python3 -c '...urllib...'`、
 * `node -e 'fetch(...)'` など書き方はいくらでもあり、名前の拒否リストではすり抜けを防げない
 * （2026-10-06 のセキュリティレビューの指摘）。
 */
const APPROVAL_TOOLS = new Set(['Bash'])

export function needsApproval(tool: string): boolean {
  return APPROVAL_TOOLS.has(tool)
}

/**
 * 承認ダイアログに出す理由。
 *
 * Why not 戻した後のコマンドをそのまま見せる: この理由はオートモードの判定器（Claude）にも渡りうるので、
 * 元の値を入れると Claude に PII が届く。伏せ字のまま、戻すことだけを知らせる。
 */
export const APPROVAL_REASON =
  'privacy-gateway: このコマンドに含まれる伏せ字（__PII_…__）を元の値に戻して実行します。' +
  '値が外部に送られないことを確かめてから許可してください。'
