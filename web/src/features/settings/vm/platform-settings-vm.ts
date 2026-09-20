// input:  redacted platform snapshots, drafts and API URL
// output: patch construction, field labels and transport policy
// pos:    Pure shared platform editor model
// >>> Once updated, update this header and parent CORTEX.md <<<

import type { PlatformSettingsSnapshot, PlatformSettingsPatch, PlatformFieldKey } from '@cortex-agent/ui-contract';
import type { Vocab } from '@/i18n';

export type PlatformDraft = Partial<Record<PlatformFieldKey, string | null>>;
export const FIELD_LABELS: Record<PlatformFieldKey, keyof Vocab> = {
  FEISHU_APP_ID: 'psAppId', FEISHU_APP_SECRET: 'psAppSecret', FEISHU_DOMAIN: 'psDomain',
  FEISHU_ENCRYPT_KEY: 'psEncryptKey', FEISHU_VERIFICATION_TOKEN: 'psVerificationToken',
  SLACK_BOT_TOKEN: 'psBotToken', SLACK_SIGNING_SECRET: 'psSigningSecret', SLACK_APP_TOKEN: 'psAppToken',
};

export function connectionPatch(
  snapshot: PlatformSettingsSnapshot, enabled: boolean, draft: PlatformDraft,
): PlatformSettingsPatch {
  const fields: PlatformSettingsPatch['fields'] = {};
  for (const field of snapshot.fields) {
    const value = draft[field.key];
    if (value === undefined || (field.secret && value === '')) continue;
    if (!field.secret && value === field.value) continue;
    Object.assign(fields, { [field.key]: value === '' ? null : value });
  }
  return { platform: snapshot.platform, ...(enabled !== snapshot.enabled ? { enabled } : {}), fields };
}

export function hasConnectionChanges(patch: PlatformSettingsPatch): boolean {
  return patch.enabled !== undefined || Object.keys(patch.fields).length > 0;
}
