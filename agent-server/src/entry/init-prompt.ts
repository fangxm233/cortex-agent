import * as clack from '@clack/prompts';
import { t } from '@core/i18n.js';

/** A cancelled `cortex init` prompt ends the wizard: nothing after it should run. */
export function handleCancel<T>(value: T): asserts value is Exclude<T, symbol> {
  if (clack.isCancel(value)) {
    clack.cancel(t('init.cancel'));
    process.exit(0);
  }
}
