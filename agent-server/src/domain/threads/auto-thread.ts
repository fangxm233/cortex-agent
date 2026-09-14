function shouldAutoRunCompound(message) {
  if (typeof message !== 'string') return true;
  return !message.includes('/compound-simple');
}

function combineFinalOutputs(primaryOutput, compoundOutput) {
  const primary = typeof primaryOutput === 'string' ? primaryOutput.trim() : '';
  const compound = typeof compoundOutput === 'string' ? compoundOutput.trim() : '';

  if (!primary) return compound || null;
  if (!compound) return primary;
  return `${primary}\n\n--- Auto compound ---\n${compound}`;
}

export {
  shouldAutoRunCompound,
  combineFinalOutputs,
};
