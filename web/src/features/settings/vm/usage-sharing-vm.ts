import type { UsageSharingSettings } from '@cortex-agent/ui-contract';

export const LEADERBOARD_URL = 'https://aistatus.cc/leaderboard';

export type UsageSharingIssue = 'name-required' | 'email-invalid';
export type UsageSharingField = 'name' | 'org' | 'email';

interface Ports {
  get: () => Promise<UsageSharingSettings>;
  set: (input: UsageSharingSettings) => Promise<UsageSharingSettings>;
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const EMPTY: UsageSharingSettings = { enabled: false, name: '', org: '', email: '' };

/** The server applies the same rule: uploads are attributed only with a name and an email. */
export function usageSharingIssues(draft: UsageSharingSettings): UsageSharingIssue[] {
  if (!draft.enabled) return [];
  const issues: UsageSharingIssue[] = [];
  if (!draft.name.trim()) issues.push('name-required');
  if (!EMAIL_RE.test(draft.email.trim())) issues.push('email-invalid');
  return issues;
}

function trimmed(s: UsageSharingSettings): UsageSharingSettings {
  return { enabled: s.enabled, name: s.name.trim(), org: s.org.trim(), email: s.email.trim() };
}

/** Identity fields only count while sharing is on; turning it off keeps whatever is stored. */
function sameChoice(a: UsageSharingSettings, b: UsageSharingSettings): boolean {
  if (a.enabled !== b.enabled) return false;
  if (!a.enabled) return true;
  const [x, y] = [trimmed(a), trimmed(b)];
  return x.name === y.name && x.org === y.org && x.email === y.email;
}

const message = (error: unknown) => error instanceof Error ? error.message : String(error);

export interface UsageSharingState {
  /** Null until the stored choice has loaded. */
  saved: UsageSharingSettings | null;
  draft: UsageSharingSettings;
  loadError: string | null;
  saving: boolean;
  saveError: string | null;
  /** Validation messages show only after a save was attempted, then follow the edits. */
  attempted: boolean;
  justSaved: boolean;
}

export class UsageSharingController {
  state: UsageSharingState = {
    saved: null, draft: EMPTY, loadError: null, saving: false, saveError: null, attempted: false, justSaved: false,
  };
  private listeners = new Set<() => void>();
  constructor(private ports: Ports) {}
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  snapshot = () => this.state;
  private patch(patch: Partial<UsageSharingState>) {
    this.state = { ...this.state, ...patch }; this.listeners.forEach(listener => listener());
  }
  private edit(draft: UsageSharingSettings) { this.patch({ draft, justSaved: false, saveError: null }); }
  load = async () => {
    try {
      const saved = await this.ports.get();
      this.patch({ saved, draft: saved, loadError: null });
    } catch (error) { this.patch({ loadError: message(error) }); }
  };
  setEnabled = (enabled: boolean) => this.edit({ ...this.state.draft, enabled });
  setField = (field: UsageSharingField, value: string) => this.edit({ ...this.state.draft, [field]: value });
  issues(): UsageSharingIssue[] { return this.state.attempted ? usageSharingIssues(this.state.draft) : []; }
  dirty(): boolean { return this.state.saved !== null && !sameChoice(this.state.saved, this.state.draft); }
  save = async () => {
    if (this.state.saving || !this.dirty()) return;
    if (usageSharingIssues(this.state.draft).length > 0) { this.patch({ attempted: true }); return; }
    this.patch({ saving: true, saveError: null });
    try {
      const saved = await this.ports.set(trimmed(this.state.draft));
      this.patch({ saved, draft: saved, attempted: false, justSaved: true });
    } catch (error) { this.patch({ saveError: message(error) }); }
    finally { this.patch({ saving: false }); }
  };
}
