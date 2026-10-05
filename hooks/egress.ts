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
 * 外部と通信しうるコマンドの目安。Bash は何でも実行できるため、ここは最善努力の網でしかない。
 */
const NETWORK_COMMAND =
  /(^|[\s;&|(`$])(curl|wget|http|https|xh|gh|ssh|scp|sftp|rsync|nc|ncat|telnet|ftp|aws|gcloud|az|mail|sendmail)(?=\s|$)|\bgit\s+(push|send-email)\b|\b(npm|pnpm|yarn|bun)\s+publish\b|\bdocker\s+push\b/

export function isNetworkBoundCommand(command: string): boolean {
  return NETWORK_COMMAND.test(command)
}

export const NETWORK_DENIAL =
  'privacy-gateway: 外部と通信しうるコマンドに伏せ字（__PII_*__）が含まれているため、元の値に戻して実行することはできません。' +
  '伏せ字を含まない形で実行するか、ユーザー自身に実行を依頼してください。'
