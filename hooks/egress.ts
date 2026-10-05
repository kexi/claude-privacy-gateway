/**
 * 伏せ字を元の値に戻してから実行してよいツール。どれも手元のファイルに作用し、
 * 引数そのものを外部サービスへ送らない。Bash は何でも実行できるので別扱い（下の BASH_TOOL）。
 *
 * Why not 全ツールで戻す: WebFetch / WebSearch / MCP（SaaS 連携）は引数が外部に出るので、
 * 戻すとせっかく伏せた値をそのまま第三者に渡してしまう。これらは伏せ字のまま実行させる。
 */
const LOCAL_TOOLS = new Set(['Read', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Glob', 'Grep'])

export const BASH_TOOL = 'Bash'

/**
 * 既定（`bashRestore: off`）で、伏せ字を含む Bash を拒否するときの理由。Claude が読む。
 *
 * Why not 伏せ字のまま実行させる: `git commit -m "__PII_PERSON_1__ の件"` のように伏せ字がそのまま
 * 書き込まれる。Why not 名前の拒否リストを通れば戻す: クォート（`c''url`）や変数展開（`curl${IFS}`）で
 * シェルの解釈とずれ、すり抜けを塞ぎきれない（2026-10-06 のセキュリティレビューの指摘）。
 */
export const BASH_DENIAL =
  'privacy-gateway: Bash には伏せ字（__PII_…__）を元の値に戻して渡しません。' +
  'ファイルの検索や編集は Read / Grep / Edit / Write を使ってください。シェルで元の値が要るときはユーザーに実行を依頼してください。'

export function isLocalTool(tool: string): boolean {
  return LOCAL_TOOLS.has(tool)
}

/**
 * 通信に使われることの多いコマンド。`/usr/bin/curl` のようなパス指定も拾う。`bashRestore: with-approval` のときだけ使う。
 *
 * 承認（`tool.check` の ask）を下すのは「モードごとの判定者」で、オートモードでは判定器（Claude）が許可しうる。
 * 人の目を通らずに伏せ字が戻って外へ出ることを減らすため、伏せ字を戻した Bash がこれに当たれば承認に関わらず拒否する。
 * 名前で見るだけの最善努力の網で、クォート（`c''url`）、変数展開（`curl${IFS}`）、`python3 -c` などは抜ける。
 * 抜けさせないことが要るなら、既定の `bashRestore: off` のまま使う。
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
