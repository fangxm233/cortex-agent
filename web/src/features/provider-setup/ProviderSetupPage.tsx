// input:  setup controller, provider icons, auth modal and i18n
// output: provider setup route styled as the native installation wizard
// pos:    New-install provider onboarding outside AppShell
// >>> Once I am updated, be sure to update my header comment and the parent folder CORTEX.md <<<
import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import type { AuthAccountStatus, LoginFlowState } from '@cortex-agent/ui-contract';
import { useVocab, type Vocab } from '@/i18n';
import { useTRPCClient } from '@/lib/trpc';
import { LoginFlowModal, type LoginFlowTarget } from '@/features/auth/LoginFlowModal';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { orderedProviders, ProviderSetupController } from './provider-setup';
import { canSetupClaude, setupClaude, claudeInstallLine } from './setup-native';
import { listenNativeEvent } from '@/lib/native-bridge';
import { SetupHeader } from './SetupHeader';
import './provider-setup.css';

function SetupButton({ primary, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" className={`setup-button ${primary ? 'setup-primary' : ''} ${className}`} {...props} />;
}
function statusCopy(account: AuthAccountStatus, L: Vocab): string {
  return { 'logged-in': L.setupConfigured, expiring: L.setupExpiring,
    'logged-out': L.setupMissing, expired: L.setupExpired, unknown: L.setupUnknown }[account.state];
}
function AccountRow({ account, login, disabled }: {
  account: AuthAccountStatus; login: (target: LoginFlowTarget) => void; disabled: boolean;
}) {
  const L = useVocab();
  const icon = account.backend === 'claude' ? 'claude-code' : account.provider;
  return <div className="setup-account" data-account-state={account.state}>
    <span className="setup-provider-icon"><ProviderIcon provider={icon} label={account.label} size={20} /></span>
    <div className="setup-account-copy"><strong>{account.label}</strong>
      <p className="setup-account-status"><span className="setup-state-dot" />{statusCopy(account, L)}</p></div>
    <div className="setup-account-actions">{account.capabilities.map(authType => <SetupButton key={authType}
      disabled={disabled} onClick={() => login({ backend: account.backend, provider: account.provider, authType })}>
      {authType === 'api_key' ? L.authLoginApiKey : L.authLoginOAuth}</SetupButton>)}</div>
  </div>;
}
function useClaudeLog() {
  const [log, setLog] = useState('');
  useEffect(() => {
    if (!canSetupClaude()) return;
    let disposed = false;
    let stop = () => {};
    void listenNativeEvent('setup-log', payload => {
      const line = claudeInstallLine(payload);
      if (!disposed && line !== null) setLog(previous => `${previous}${line}\n`.slice(-6000));
    }).then(unlisten => { if (disposed) unlisten(); else stop = unlisten; });
    return () => { disposed = true; stop(); };
  }, []);
  return log;
}
function ClaudeActions({ controller, account, login }: {
  controller: ProviderSetupController; account?: AuthAccountStatus; login: (target: LoginFlowTarget) => void;
}) {
  const L = useVocab(), s = controller.state;
  const start = async (target: LoginFlowTarget) => { if (await controller.prepareClaude()) login(target); };
  if (!canSetupClaude()) return <p className="setup-hint">{L.setupCcLocal}</p>;
  if (s.claude === null) return <SetupButton disabled={s.claudeBusy} onClick={controller.detectClaude}>{L.setupRetry}</SetupButton>;
  if (!account) return null;
  return s.claude.installed ? <AccountRow account={account} disabled={s.claudeBusy || s.busy} login={start} />
    : <div className="setup-install-row"><p className="setup-hint">{L.setupCcConsent}</p>
      <SetupButton disabled={s.claudeBusy || s.busy || !account.capabilities.length}
        onClick={() => start({ backend: 'claude', provider: account.provider, authType: account.capabilities.includes('oauth') ? 'oauth' : account.capabilities[0]! })}>
        {L.setupCcInstall}</SetupButton></div>;
}
function ClaudeSection({ controller, login }: {
  controller: ProviderSetupController; login: (target: LoginFlowTarget) => void;
}) {
  const L = useVocab(), s = controller.state;
  const log = useClaudeLog();
  const installed = s.claude === null ? L.setupUnknown : s.claude.installed ? L.setupCcInstalled : L.setupCcMissing;
  return <section className="setup-card">
    <div className="setup-card-header"><ProviderIcon provider="claude-code" label="Claude Code" size={20} />
      <h2>Claude Code</h2><span className="setup-pill">{L.setupOptional} · {installed}</span></div>
    <div className="setup-card-body setup-cc-body">
      <ClaudeActions controller={controller} account={s.status?.accounts.find(a => a.backend === 'claude')} login={login} />
      {s.claudeBusy ? <p className="setup-hint" role="status">{L.setupWorking}</p> : null}
      {log ? <pre className="setup-log">{log}</pre> : null}
      {s.claudeError ? <p role="alert" className="setup-error">{s.claudeError}</p> : null}
    </div>
  </section>;
}
function ProfileSection({ controller }: { controller: ProviderSetupController }) {
  const L = useVocab();
  const available = controller.available();
  const current = controller.state.profiles?.defaultProfile ?? '';
  const matching = available.some(p => p.name === current);
  return <section className="setup-card">
    <div className="setup-card-header"><h2><label htmlFor="setup-profile">{L.setupProfile}</label></h2>
      {current ? <span className="setup-pill">{current}</span> : null}</div>
    <div className="setup-card-body setup-profile-body">
      <select id="setup-profile" className="setup-input" disabled={controller.state.busy || !available.length} value={matching ? current : ''}
        onChange={event => void controller.select(event.target.value)}>
        <option value="" disabled>{L.setupChooseProfile}</option>
        {available.map(p => <option key={p.name} value={p.name}>{p.name} · {p.model} · {p.backend ?? 'claude'}</option>)}
      </select>
      {!matching ? <p className="setup-hint">{available.length ? L.setupMismatch : L.setupNoProfiles}</p> : null}
    </div>
  </section>;
}
function SetupFooter({ controller, leave }: { controller: ProviderSetupController; leave: () => void }) {
  const L = useVocab();
  return <footer className="setup-footer">
    <div className="setup-footer-actions">
      <SetupButton data-action="setup-skip" onClick={leave}>{L.setupSkip}</SetupButton>
      <SetupButton data-action="setup-continue" primary disabled={!controller.canContinue()}
        onClick={() => { if (controller.canContinue()) leave(); }}>{L.setupContinue}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </SetupButton>
    </div>
    <p className="setup-footnote">{L.setupSkipWarning}</p>
    <p className="setup-footnote">{L.setupHonesty}</p>
  </footer>;
}
function PiSection({ controller, login }: { controller: ProviderSetupController; login: (target: LoginFlowTarget) => void }) {
  const L = useVocab();
  const [search, setSearch] = useState('');
  const s = controller.state;
  return <section className="setup-card">
    <div className="setup-card-header"><h2>PI</h2><span className="setup-pill setup-good">{L.setupBundled}</span>
      <SetupButton className="setup-rescan" disabled={s.busy} onClick={controller.refresh}>{s.busy ? L.setupWorking : L.setupRescan}</SetupButton></div>
    {s.status && !s.status.piRuntime.available ? <p role="alert" className="setup-error">{L.setupRuntimeError}: {s.status.piRuntime.error}</p> : null}
    <div className="setup-search"><input type="search" aria-label={L.setupSearch} placeholder={L.setupSearch} value={search}
      onChange={event => setSearch(event.target.value)} className="setup-input" /></div>
    <div className="setup-providers">{orderedProviders(s.status?.accounts ?? [], search).map(account =>
      <AccountRow key={account.provider} account={account} disabled={s.busy || !s.status?.piRuntime.available} login={login} />)}</div>
  </section>;
}
function SetupFeedback({ controller }: { controller: ProviderSetupController }) {
  const L = useVocab(), s = controller.state;
  return <>
    {s.sync === 'success' ? <p className="setup-feedback" role="status">{L.setupSyncSuccess}</p> : null}
    {s.error ? <p role="alert" className="setup-error">{L.setupSyncFailed}: {s.error}</p> : null}
  </>;
}
export function ProviderSetupView({ controller, leave }: { controller: ProviderSetupController; leave: () => void }) {
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const L = useVocab();
  const [target, setTarget] = useState<LoginFlowTarget | null>(null);
  const flowChanged = useCallback((state: LoginFlowState) => {
    if (state.step === 'done') void controller.loginDone(state.flowId);
  }, [controller]);
  return <><main className="setup-workspace">
    <header><div className="setup-eyebrow">{L.setupEyebrow}</div><h1>{L.setupTitle}</h1>
      <p className="setup-intro">{L.setupDescription}</p></header>
    <PiSection controller={controller} login={setTarget} />
    <SetupFeedback controller={controller} />
    <ClaudeSection controller={controller} login={setTarget} />
    <ProfileSection controller={controller} />
    <SetupFooter controller={controller} leave={leave} />
  </main><LoginFlowModal open={!!target} target={target} onClose={() => setTarget(null)} onFlowStateChange={flowChanged} /></>;
}
export function ProviderSetupPage() {
  const client = useTRPCClient();
  const navigate = useNavigate();
  const controller = useMemo(() => new ProviderSetupController({
    status: () => client.auth.status.query({}), config: () => client.config.get.query({}),
    sync: () => client.auth.syncGateway.mutate({}),
    select: name => client.config.set.mutate({ section: 'profiles', value: { defaultProfile: name } }),
    claude: () => setupClaude(false), install: () => setupClaude(true), canInstall: canSetupClaude,
  }), [client]);
  useEffect(() => { void controller.load(); }, [controller]);
  return <div className="provider-setup">
    <SetupHeader />
    <div className="setup-scroll"><ProviderSetupView controller={controller} leave={() => navigate('/workbench', { replace: true })} /></div>
  </div>;
}
