import { windowActionsEn, windowActionsZh } from './window-actions-vocab';
import { nativeShellEn, nativeShellZh } from './native-shell-vocab';
import { commonEn, commonZh } from './common-vocab';
import { timeEn, timeZh } from './time-vocab';
import { updateCheckEn, updateCheckZh } from './update-check-vocab';
import { platformEn, platformZh } from './platform-settings-vocab';
import { pluginEn, pluginZh } from './plugins-vocab';
import { setupEn, setupZh } from './provider-setup-vocab';
import { uiAuthEn, uiAuthZh } from './ui-auth-vocab';
import { browserEn, browserZh } from './browser-vocab';
import { dockEn, dockZh, mediaEn, mediaZh } from './media-vocab';
import {
  approvalsEn, approvalsZh, attachmentsEn, attachmentsZh, paletteEn, paletteZh, workbenchEn, workbenchZh,
} from './workbench-vocab';
import { chatEn, chatZh, messageEn, messageZh } from './chat-vocab';
import { interactionEn, interactionZh } from './interaction-vocab';
import { railEn, railZh } from './rail-vocab';
import { daemonEn, daemonZh } from './daemon-vocab';
import { machinesEn, machinesZh } from './machines-vocab';
import { usageEn, usageZh } from './usage-vocab';
import { settingsSystemEn, settingsSystemZh } from './settings-system-vocab';
import { enBase } from './vocab-en-base';
import { enExtra } from './vocab-en-extra';
import { zhBase } from './vocab-zh-base';
import { zhExtra } from './vocab-zh-extra';

export const en = {
  ...enBase,
  ...pluginEn,
  ...enExtra,
  ...setupEn,
  ...platformEn,
  ...updateCheckEn,
  ...uiAuthEn,
  ...windowActionsEn,
  ...nativeShellEn,
  ...commonEn,
  ...timeEn,
  ...browserEn,
  ...mediaEn,
  ...dockEn,
  ...paletteEn,
  ...workbenchEn,
  ...chatEn,
  ...interactionEn,
  ...messageEn,
  ...railEn,
  ...approvalsEn,
  ...attachmentsEn,
  ...daemonEn,
  ...machinesEn,
  ...usageEn,
  ...settingsSystemEn,
};

export type Vocab = typeof en;

export const zh: Record<keyof Vocab, string> = {
  ...zhBase,
  ...pluginZh,
  ...zhExtra,
  ...setupZh,
  ...platformZh,
  ...updateCheckZh,
  ...uiAuthZh,
  ...windowActionsZh,
  ...nativeShellZh,
  ...commonZh,
  ...timeZh,
  ...browserZh,
  ...mediaZh,
  ...dockZh,
  ...paletteZh,
  ...workbenchZh,
  ...chatZh,
  ...interactionZh,
  ...messageZh,
  ...railZh,
  ...approvalsZh,
  ...attachmentsZh,
  ...daemonZh,
  ...machinesZh,
  ...usageZh,
  ...settingsSystemZh,
};
