import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import type { ButtonHTMLAttributes } from 'react';
import { useNavigate } from 'react-router-dom';
import type { LoginFlowState } from '@cortex-agent/ui-contract';
import { useVocab } from '@/i18n';
import { useTRPCClient } from '@/lib/trpc';
import { LoginFlowModal, type LoginFlowTarget } from '@/features/auth/LoginFlowModal';
import { ProviderIcon } from '@/features/auth/ProviderIcon';
import { buildAccountsVm, type ClaudeAccountVm } from '@/features/settings/vm/accounts-vm';
import {
  AvailableGrid, ClaudeSlots, ConnectedList, ProviderSearch, useLogoutConfirm,
} from '@/features/settings/ui/account-rows';
import { ProviderSetupController, setupErrorText } from './provider-setup';
import { canSetupClaude, setupClaude, claudeInstallLine } from './setup-native';
import { invokeNative, listenNativeEvent } from '@/lib/native-bridge';
import { isNativeShell, readDesktopConfig } from '@/lib/desktop-config';
import { SetupHeader } from './SetupHeader';
import { UsageSharingCard } from '@/features/settings/panels/UsageSharingCard';
import type { UsageSharingController } from '@/features/settings/vm/usage-sharing-vm';
import { useUsageSharingController } from '@/features/settings/controllers/useUsageSharingController';
import './provider-setup.css';

function SetupButton({ primary, className = '', ...props }: ButtonHTMLAttributes<HTMLButtonElement> & { primary?: boolean }) {
  return <button type="button" className={`setup-button ${primary ? 'setup-primary' : ''} ${className}`} {...props} />;
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
  controller: ProviderSetupController; account: ClaudeAccountVm | null; login: (target: LoginFlowTarget) => void;
}) {
  const L = useVocab(), s = controller.state;
  const confirm = useLogoutConfirm();
  const start = async (target: LoginFlowTarget) => { if (await controller.prepareClaude()) login(target); };
  if (!canSetupClaude()) return <p className="setup-hint">{L.setupCcLocal}</p>;
  if (s.claude === null) return <SetupButton disabled={s.claudeBusy} onClick={controller.detectClaude}>{L.setupRetry}</SetupButton>;
  if (!account) return null;
  if (s.claude.installed) {
    return <ClaudeSlots account={account} confirm={confirm}
      handlers={{ onLogin: target => void start(target), disabled: s.claudeBusy || s.busy }} />;
  }
  const subscription = account.slots.find(slot => slot.authType === 'oauth' && slot.canLogin) ?? account.slots.find(slot => slot.canLogin);
  return <div className="setup-install-row"><p className="setup-hint">{L.setupCcConsent}</p>
    <SetupButton disabled={s.claudeBusy || s.busy || !subscription}
      onClick={() => subscription && void start({ backend: 'claude', provider: account.provider, authType: subscription.authType, label: account.label })}>
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
      <ClaudeActions controller={controller} account={s.status ? buildAccountsVm(s.status).claude : null} login={login} />
      {s.claudeBusy ? <p className="setup-hint" role="status">{L.setupWorking}</p> : null}
      {log ? <pre className="setup-log">{log}</pre> : null}
      {s.claudeError ? <p role="alert" className="setup-error">{setupErrorText(s.claudeError, L)}</p> : null}
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
interface SetupExit { leave: () => void; saving?: boolean; failed?: boolean }
function SetupFooter({ controller, leave, saving = false, failed = false }: { controller: ProviderSetupController } & SetupExit) {
  const L = useVocab();
  return <footer className="setup-footer">
    <div className="setup-footer-actions">
      <SetupButton data-action="setup-skip" disabled={saving} onClick={leave}>{L.setupSkip}</SetupButton>
      <SetupButton data-action="setup-continue" primary disabled={saving || !controller.canContinue()}
        onClick={() => { if (!saving && controller.canContinue()) leave(); }}>{L.setupContinue}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true"><path d="m9 5 7 7-7 7" /></svg>
      </SetupButton>
    </div>
    {failed ? <p role="alert" className="setup-error">{L.setupSaveFailed}</p> : null}
    <p className="setup-footnote">{L.setupSkipWarning}</p>
    <p className="setup-footnote">{L.setupHonesty}</p>
  </footer>;
}
function PiSection({ controller, login }: { controller: ProviderSetupController; login: (target: LoginFlowTarget) => void }) {
  const L = useVocab();
  const [search, setSearch] = useState('');
  const confirm = useLogoutConfirm();
  const s = controller.state;
  const vm = s.status ? buildAccountsVm(s.status, search) : null;
  const handlers = { onLogin: login, disabled: s.busy || !s.status?.piRuntime.available };
  return <section className="setup-card">
    <div className="setup-card-header"><h2>{L.setupProviders}</h2>
      <SetupButton className="setup-rescan" disabled={s.busy} onClick={controller.refresh}>{s.busy ? L.setupWorking : L.setupRescan}</SetupButton></div>
    {s.status && !s.status.piRuntime.available ? <p role="alert" className="setup-error">{L.setupRuntimeError}: {s.status.piRuntime.error}</p> : null}
    {vm ? <div className="setup-card-body setup-accounts">
      {vm.connected.length > 0 ? <div className="setup-accounts-group">
        <h3>{L.accountsConnected} · {vm.connected.length}</h3>
        <ConnectedList providers={vm.connected} handlers={handlers} confirm={confirm} />
      </div> : null}
      {vm.availableTotal > 0 ? <div className="setup-accounts-group">
        <h3>{L.accountsAddProvider} · {vm.availableTotal}</h3>
        <ProviderSearch value={search} onChange={setSearch} />
        <AvailableGrid providers={vm.available} handlers={handlers} />
      </div> : null}
    </div> : null}
  </section>;
}
function SetupFeedback({ controller }: { controller: ProviderSetupController }) {
  const L = useVocab(), s = controller.state;
  return <>
    {s.sync === 'success' ? <p className="setup-feedback" role="status">{L.setupSyncSuccess}</p> : null}
    {s.error ? <p role="alert" className="setup-error">{L.setupSyncFailed}: {setupErrorText(s.error, L)}</p> : null}
  </>;
}
export function ProviderSetupView({ controller, usageSharing, ...exit }: {
  controller: ProviderSetupController; usageSharing?: UsageSharingController;
} & SetupExit) {
  useSyncExternalStore(controller.subscribe, controller.snapshot);
  const L = useVocab();
  const [target, setTarget] = useState<LoginFlowTarget | null>(null);
  const loginDone = useCallback((state: LoginFlowState) => { void controller.loginDone(state.flowId); }, [controller]);
  return <><main className="setup-workspace">
    <header><div className="setup-eyebrow">{L.setupEyebrow}</div><h1>{L.setupTitle}</h1>
      <p className="setup-intro">{L.setupDescription}</p></header>
    <PiSection controller={controller} login={setTarget} />
    <SetupFeedback controller={controller} />
    <ClaudeSection controller={controller} login={setTarget} />
    <ProfileSection controller={controller} />
    {usageSharing ? <UsageSharingCard controller={usageSharing} variant="setup" /> : null}
    <SetupFooter controller={controller} {...exit} />
  </main><LoginFlowModal open={!!target} target={target} onClose={() => setTarget(null)} onDone={loginDone} /></>;
}
function useProviderSetupExit(): SetupExit {
  const navigate = useNavigate();
  // Keep the page's original identity, not a later IPC refresh or replacement connection.
  const [connection] = useState(() => isNativeShell() ? readDesktopConfig() : undefined);
  const exiting = useRef(false);
  const [saving, setSaving] = useState(false);
  const [failed, setFailed] = useState(false);
  const leave = async () => {
    if (exiting.current) return;
    exiting.current = true;
    setSaving(true);
    setFailed(false);
    try {
      if (connection?.providerSetupPending === true) {
        await invokeNative('finish_provider_setup', { serverUrl: connection.serverUrl, token: connection.token });
      }
      navigate('/workbench', { replace: true });
    } catch {
      // Never display native persistence details: they can include connection credentials.
      exiting.current = false;
      setSaving(false);
      setFailed(true);
    }
  };
  return { leave, saving, failed };
}
export function ProviderSetupPage() {
  const client = useTRPCClient();
  const exit = useProviderSetupExit();
  const controller = useMemo(() => new ProviderSetupController({
    status: () => client.auth.status.query({}), config: () => client.config.get.query({}),
    sync: () => client.auth.syncGateway.mutate({}),
    select: name => client.config.set.mutate({ section: 'profiles', value: { defaultProfile: name } }),
    claude: () => setupClaude(false), install: () => setupClaude(true), canInstall: canSetupClaude,
  }), [client]);
  useEffect(() => { void controller.load(); }, [controller]);
  const usageSharing = useUsageSharingController();
  return <div className="provider-setup">
    <SetupHeader />
    <div className="setup-scroll"><ProviderSetupView controller={controller} usageSharing={usageSharing} {...exit} /></div>
  </div>;
}
