import { windowActionsEn, windowActionsZh } from './window-actions-vocab';
import { nativeShellEn, nativeShellZh } from './native-shell-vocab';
import { commonEn, commonZh } from './common-vocab';
import { timeEn, timeZh } from './time-vocab';
import { updateCheckEn, updateCheckZh } from './update-check-vocab';
import { platformEn, platformZh } from './platform-settings-vocab';
import { pluginEn, pluginZh } from './plugins-vocab';
import { setupEn, setupZh } from './provider-setup-vocab';
import { onboardingEn, onboardingZh } from './onboarding-vocab';
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
import { pairingEn, pairingZh } from './pairing-vocab';
import { usageEn, usageZh } from './usage-vocab';
import { settingsSystemEn, settingsSystemZh } from './settings-system-vocab';
import { projectEn, projectZh } from './project-vocab';
import { contentEn, contentZh } from './content-vocab';
import { boardEn, boardZh } from './board-vocab';
import { uninstallEn, uninstallZh } from './uninstall-vocab';
import { telemetryEn, telemetryZh } from './telemetry-vocab';
import { enBase } from './vocab-en-base';
import { enExtra } from './vocab-en-extra';
import { zhBase } from './vocab-zh-base';
import { zhExtra } from './vocab-zh-extra';

export const en = {
  ...enBase,
  ...pluginEn,
  ...enExtra,
  ...setupEn,
  ...onboardingEn,
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
  ...pairingEn,
  ...usageEn,
  ...settingsSystemEn,
  ...projectEn,
  ...contentEn,
  ...boardEn,
  ...uninstallEn,
  ...telemetryEn,
};

export type Vocab = typeof en;

export const zh: Record<keyof Vocab, string> = {
  ...zhBase,
  ...pluginZh,
  ...zhExtra,
  ...setupZh,
  ...onboardingZh,
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
  ...pairingZh,
  ...usageZh,
  ...settingsSystemZh,
  ...projectZh,
  ...contentZh,
  ...boardZh,
  ...uninstallZh,
  ...telemetryZh,
};
