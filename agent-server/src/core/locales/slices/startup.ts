// input:  nothing (leaf data slice)
// output: startupEn / startupZh — message slice (filled by i18n extraction)
// pos:    one locale slice; aggregated by core/locales/en.ts & zh.ts barrels
// >>> Keep en and zh keys in lockstep (zh typed against keyof typeof startupEn) <<<

export const startupEn = {
  'startup.started': 'Cortex agent v${version} started on ${machine}.',
  'startup.restarted': 'Cortex agent v${version} restarted on ${machine}.',
  'startup.reason': ' Reason: ${reason}.',
  'startup.rebuildHold': 'Cortex is rebuilding itself (${phase}) and is about to restart, so this message was not processed. Send it again in a moment.',
  'startup.rebuildHoldDropped': 'A message for ${channel} arrived during the rebuild (${phase}) and was not processed: ${preview}',
} as const;

export const startupZh: Record<keyof typeof startupEn, string> = {
  'startup.started': 'Cortex 代理 v${version} 已在 ${machine} 上启动。',
  'startup.restarted': 'Cortex 代理 v${version} 已在 ${machine} 上重启。',
  'startup.reason': ' 原因：${reason}。',
  'startup.rebuildHold': 'Cortex 正在热重建（${phase}）并即将重启，这条消息没有被处理。请稍后重发。',
  'startup.rebuildHoldDropped': '重建期间（${phase}）收到一条发往 ${channel} 的消息，未被处理：${preview}',
};
