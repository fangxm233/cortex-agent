// input:  zod and platform credential field definitions
// output: platform configuration contract and safe patch schema
// pos:    Browser-safe platform settings boundary
// >>> Once updated, update this header and parent CORTEX.md <<<

import { z } from 'zod';

export type MessagingPlatform = 'feishu' | 'slack';
export const PLATFORM_FIELDS = {
  feishu: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET', 'FEISHU_DOMAIN', 'FEISHU_ENCRYPT_KEY', 'FEISHU_VERIFICATION_TOKEN'],
  slack: ['SLACK_BOT_TOKEN', 'SLACK_SIGNING_SECRET', 'SLACK_APP_TOKEN'],
} as const;
export type PlatformFieldKey = (typeof PLATFORM_FIELDS)[MessagingPlatform][number];
export const PLATFORM_REQUIRED: Record<MessagingPlatform, readonly PlatformFieldKey[]> = {
  feishu: ['FEISHU_APP_ID', 'FEISHU_APP_SECRET'],
  slack: PLATFORM_FIELDS.slack,
};
export const PUBLIC_PLATFORM_FIELDS: readonly PlatformFieldKey[] = ['FEISHU_APP_ID', 'FEISHU_DOMAIN'];

export interface PlatformFieldSnapshot {
  key: PlatformFieldKey;
  secret: boolean;
  present: boolean;
  runtimePresent: boolean;
  differs: boolean;
  /** Only public fields carry a value. Secrets are presence-only. */
  value?: string;
}
export interface PlatformSettingsSnapshot {
  platform: MessagingPlatform;
  enabled: boolean;
  runtimeEnabled: boolean;
  missing: PlatformFieldKey[];
  pendingRestart: boolean;
  fields: PlatformFieldSnapshot[];
}

// Single-quoted dotenv values: forbid quote/escape/control characters rather than interpreting
// them. Error messages are fixed; invalid credential text must never become a response or log.
const credential = z.string().min(1).max(4096).regex(/^[^\s'\\\u0000-\u001f\u007f]+$/, 'Invalid credential characters');
const fields = z.object({
  FEISHU_APP_ID: credential.nullable().optional(),
  FEISHU_APP_SECRET: credential.nullable().optional(),
  FEISHU_DOMAIN: z.enum(['feishu', 'lark']).nullable().optional(),
  FEISHU_ENCRYPT_KEY: credential.nullable().optional(),
  FEISHU_VERIFICATION_TOKEN: credential.nullable().optional(),
  SLACK_BOT_TOKEN: credential.nullable().optional(),
  SLACK_SIGNING_SECRET: credential.nullable().optional(),
  SLACK_APP_TOKEN: credential.nullable().optional(),
}).strict();

export const platformSettingsInput = z.object({
  platform: z.enum(['feishu', 'slack']),
  enabled: z.boolean().optional(),
  fields,
}).strict().refine(
  patch => Object.keys(patch.fields).every(key => (PLATFORM_FIELDS[patch.platform] as readonly string[]).includes(key)),
  'Fields must belong to the selected platform',
);
export type PlatformSettingsPatch = z.infer<typeof platformSettingsInput>;
