import { toDailyEvent } from './daily.js';
import { loadNameCatalog } from './normalize.js';
import { dropRollupDay, finishedRollups, persistRollup, utcDay, wipeRollups } from './rollup.js';
import { recordTelemetryEvent, registerTelemetryHooks } from './service.js';

/** Queue every finished day as a `daily` event, then forget it locally. */
export async function queueFinishedDays(now: number): Promise<void> {
  const days = finishedRollups(now);
  if (days.length === 0) return;
  const catalog = await loadNameCatalog(utcDay(now));
  for (const rollup of days) {
    const event = toDailyEvent(rollup, catalog);
    if (!event || recordTelemetryEvent(event)) dropRollupDay(rollup.day);
  }
}

/** Hook the rollup store into the service's persist / finalize / wipe moments. */
export function installDailyUpload(): void {
  registerTelemetryHooks({ persist: persistRollup, finalize: queueFinishedDays, wipe: wipeRollups });
}
