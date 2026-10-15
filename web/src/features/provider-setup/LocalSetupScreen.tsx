import { useEffect, useRef, useState, useSyncExternalStore, type FormEvent } from 'react';
import { useLang, useVocab, type Vocab } from '@/i18n';
import { invokeNative, listenNativeEvent } from '@/lib/native-bridge';
import {
  LocalSetupFlow, localSetupErrorText, setupLogLine,
  type LocalSetupPorts, type LocalSetupState, type LocalSetupStep, type LocalSetupWarning, type LocalStepStatus,
} from './local-setup';
import { ChevronIcon, MonitorIcon } from './onboarding-icons';

const nativePorts: LocalSetupPorts = {
  probe: () => invokeNative('setup_probe'),
  installServer: () => invokeNative('setup_install_server', { run: 'install' }),
  cancelInstall: () => invokeNative('setup_cancel_install'),
  runInit: (bin, answers) => invokeNative('setup_run_init', { run: 'start', bin, answers }),
  enableUi: (bin, port) => invokeNative('setup_enable_ui', { run: 'start', bin, port }),
  startDaemon: (bin, { url, token }, restart) => invokeNative('setup_start_daemon', { run: 'start', bin, url, token, restart }),
  enableAutostart: () => invokeNative('setup_enable_autostart', { run: 'start' }),
  setTerminalCli: (bin, enabled) => invokeNative('setup_terminal_cli', { run: 'start', bin, enabled }),
  connect: ({ url, token }, cortexBin, newInstall) => invokeNative('connect', {
    serverUrl: url, token, local: { cortexBin, ...(newInstall === true ? { providerSetupPending: true } : {}) },
  }),
};

const STEP_LABEL: Record<LocalSetupStep, keyof Vocab> = {
  check: 'onbStepCheck', install: 'onbStepInstall', config: 'onbStepConfig',
  daemon: 'onbStepDaemon', autostart: 'onbStepAutostart', terminal: 'onbStepTerminal', connect: 'onbStepConnect',
};
const WARNING_TEXT: Record<LocalSetupWarning, keyof Vocab> = {
  AUTOSTART_FAILED: 'onbAutostartWarning', CLI_PATH_FAILED: 'onbTerminalWarning',
};
const STATUS_LABEL: Record<LocalStepStatus, keyof Vocab> = {
  pending: 'onbStatusPending', running: 'onbStatusRunning', done: 'onbStatusDone',
  error: 'onbStatusError', warning: 'onbStatusWarning',
};
const STATUS_ICON: Partial<Record<LocalStepStatus, string>> = { done: '✓', error: '!', warning: '!' };

function visibleSteps(state: LocalSetupState): LocalSetupStep[] {
  if (state.stage === 'prepare' || state.automatic) return ['install'];
  const terminal: LocalSetupStep[] = state.answers?.installCli ? ['terminal'] : [];
  const autostart: LocalSetupStep[] = state.answers?.installService ? ['autostart'] : [];
  return ['config', ...terminal, 'daemon', ...autostart, 'connect'];
}

function stepStatus(step: LocalSetupStep, state: LocalSetupState): LocalStepStatus {
  // Automatic setup stays one installation row through init, daemon and connection.
  const combined = step === 'install' && (state.stage === 'prepare' || state.automatic);
  return state.progress[combined ? state.active ?? 'check' : step] ?? 'pending';
}

function StepRow({ step, state }: { step: LocalSetupStep; state: LocalSetupState }) {
  const L = useVocab();
  const status = stepStatus(step, state);
  return <div className="onb-status-row" data-status={status}>
    <span className="onb-status-icon" aria-hidden="true">{STATUS_ICON[status] ?? ''}</span>
    <div><strong>{L[STEP_LABEL[step]]}</strong></div>
    <span className="onb-status-value">{L[STATUS_LABEL[status]]}</span>
  </div>;
}

function ProgressSection({ state, log }: { state: LocalSetupState; log: string }) {
  const L = useVocab();
  const starting = !state.automatic && (state.stage === 'start' || state.stage === 'ready');
  const logView = useRef<HTMLPreElement>(null);
  useEffect(() => { if (logView.current) logView.current.scrollTop = logView.current.scrollHeight; }, [log]);
  const title = state.stage === 'ready' ? L.onbReadyTitle : starting ? L.onbOpeningTitle : L.onbPreparingTitle;
  const intro = state.stage === 'ready' && state.warning ? L[WARNING_TEXT[state.warning]]
    : state.automatic ? L.onbAutomaticIntro : starting ? L.onbOpeningIntro : L.onbPreparingIntro;
  return <section>
    <div className="setup-eyebrow">{starting ? L.onbAlmostThere : L.onbLocalInstallation}</div>
    <h1>{title}</h1>
    <p className="setup-intro">{intro}</p>
    <div className="setup-card">
      <div className="setup-card-header"><MonitorIcon />
        <h2>{starting ? L.onbStartingHeading : L.onbPreparingHeading}</h2>
        <span className="setup-pill">{state.error ? L.onbNeedsAttention : L.onbAutomatic}</span></div>
      <div className="onb-progress-body" role="status" aria-live="polite">
        {visibleSteps(state).map(step => <StepRow key={step} step={step} state={state} />)}
      </div>
      <details className="onb-log-details"><summary>{L.onbActivityLog}</summary>
        <pre ref={logView} className="setup-log">{log}{state.error ? `\n${state.error}` : ''}</pre></details>
    </div>
  </section>;
}

type StartLocal = (machine: string, autostart: boolean, terminal: boolean, port: number) => void;

function useMachineSettings(state: LocalSetupState, start: StartLocal) {
  const L = useVocab();
  // Editing after a failed start reopens this form with what was submitted.
  const [machine, setMachine] = useState(state.answers?.machineName ?? state.probe?.hostname ?? '');
  const [autostart, setAutostart] = useState(state.answers?.installService ?? false);
  const [terminal, setTerminal] = useState(state.answers?.installCli ?? true);
  const [port, setPort] = useState(String(state.answers?.port ?? 3004));
  const machineInput = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const autostartOffered = state.probe?.os !== 'windows';
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (state.needsInit && !machine.trim()) {
      machineInput.current?.setCustomValidity(L.onbMachineRequired);
      form.current?.reportValidity();
      return;
    }
    start(machine.trim(), autostart && autostartOffered && state.needsInit, terminal, Number(port));
  };
  return {
    machine, setMachine, autostart, setAutostart, terminal, setTerminal, port, setPort, machineInput, form, autostartOffered, submit,
  };
}

function ConfigureSection({ state, start }: { state: LocalSetupState; start: StartLocal }) {
  const L = useVocab();
  const settings = useMachineSettings(state, start);
  return <section>
    <div className="setup-eyebrow">{L.onbSetupEyebrow}</div>
    <h1>{L.onbSetupTitle}</h1>
    <p className="setup-intro">{L.onbSetupIntro}</p>
    <form ref={settings.form} className="setup-card" onSubmit={settings.submit}
      onInput={() => settings.machineInput.current?.setCustomValidity('')}>
      <div className="setup-card-header"><MonitorIcon /><h2>{L.onbThisComputer}</h2></div>
      <MachineFields needsInit={state.needsInit} settings={settings} />
      <div className="onb-action-bar"><p className="setup-hint">{L.onbChangeLater}</p>
        <button type="submit" className="setup-button setup-primary" data-action="onb-start" disabled={state.busy || state.cancelling}>
          {L.onbStart}<ChevronIcon /></button></div>
    </form>
  </section>;
}

function MachineFields({ needsInit, settings: s }: { needsInit: boolean; settings: ReturnType<typeof useMachineSettings> }) {
  const L = useVocab();
  return <div className="setup-card-body">
    {needsInit ? null : <div className="onb-notice">{L.onbExistingKept}</div>}
    <fieldset className="onb-fieldset" hidden={!needsInit} disabled={!needsInit}>
      <label className="onb-field" htmlFor="onb-machine"><span className="onb-label">{L.onbMachineName}</span>
        <input ref={s.machineInput} id="onb-machine" className="setup-input" required maxLength={80} autoComplete="off"
          spellCheck={false} value={s.machine} onChange={event => s.setMachine(event.target.value)} />
        <span className="setup-hint">{L.onbMachineHint}</span></label>
      {s.autostartOffered ? <label className="onb-toggle-row">
        <div><strong>{L.onbStartAtLogin}</strong><p className="setup-hint">{L.onbStartAtLoginHint}</p></div>
        <input className="onb-toggle" type="checkbox" checked={s.autostart} onChange={event => s.setAutostart(event.target.checked)} />
      </label> : null}
    </fieldset>
    <label className="onb-toggle-row">
      <div><strong>{L.onbTerminalCommand}</strong><p className="setup-hint">{L.onbTerminalCommandHint}</p></div>
      <input className="onb-toggle" type="checkbox" checked={s.terminal} onChange={event => s.setTerminal(event.target.checked)} />
    </label>
    <details className="onb-advanced"><summary>{L.onbAdvanced}</summary>
      <label className="onb-field" htmlFor="onb-port"><span className="onb-label">{L.onbLocalPort}</span>
        <input id="onb-port" className="setup-input onb-mono" type="number" min={1} max={65535} required
          value={s.port} onChange={event => s.setPort(event.target.value)} /></label>
    </details>
  </div>;
}

function ErrorBox({ state, retry, edit, otherOptions }: {
  state: LocalSetupState; retry: () => void; edit: () => void; otherOptions: () => void;
}) {
  const L = useVocab();
  if (!state.error) return null;
  return <div className="onb-error-box" role="alert">
    <strong>{L.onbStepFailed}</strong><p>{localSetupErrorText(state.error, L)}</p>
    <div className="onb-error-actions">
      <button type="button" className="setup-button setup-primary" data-action="onb-retry" disabled={state.busy || state.cancelling} onClick={retry}>{L.onbTryAgain}</button>
      {state.stage === 'start' ? <button type="button" className="setup-button" onClick={edit}>{L.onbEditSettings}</button> : null}
      <button type="button" className="onb-link" onClick={otherOptions}>{L.onbOtherOptions}</button>
    </div>
  </div>;
}

export function LocalSetupView({ flow, log, otherOptions, clearLog }: {
  flow: LocalSetupFlow; log: string; otherOptions: () => void; clearLog: () => void;
}) {
  const state = useSyncExternalStore(flow.subscribe, flow.snapshot);
  const L = useVocab();
  const lang = useLang();
  const start = (machineName: string, installService: boolean, installCli: boolean, port: number) => {
    clearLog();
    void flow.start({ lang, machineName, backends: ['pi'], installService, installCli, port, restartDaemon: true });
  };
  const retry = () => {
    if (state.stage === 'prepare') void flow.prepare(lang);
    else if (state.answers) void flow.start(state.answers);
  };
  return <>
    {state.stage === 'configure' ? <ConfigureSection state={state} start={start} /> : <ProgressSection state={state} log={log} />}
    {state.stage === 'prepare' && state.busy && state.active === 'install' ?
      <button type="button" className="onb-link" data-action="onb-cancel" disabled={state.cancelling}
        onClick={() => void flow.cancelInstall()}>{L.onbCancelInstall}</button> : null}
    <ErrorBox state={state} retry={retry} edit={flow.configure} otherOptions={otherOptions} />
    {state.stage === 'configure' || state.error ? null : <p className="setup-footnote">{L.onbKeepOpen}</p>}
  </>;
}

function useLocalSetup() {
  const lang = useLang();
  const [log, setLog] = useState('');
  const [setup] = useState(() => {
    let listening!: () => void;
    const ready = new Promise<void>(resolve => { listening = resolve; });
    return { flow: new LocalSetupFlow(nativePorts, ready), listening, lang };
  });
  useEffect(() => {
    let disposed = false;
    let stop = () => {};
    void listenNativeEvent('setup-log', payload => {
      const line = setupLogLine(payload);
      if (!disposed && line !== null) setLog(previous => `${previous}${line}\n`.slice(-24000));
    }).then(unlisten => {
      if (disposed) unlisten(); else stop = unlisten;
      setup.listening();
    });
    void setup.flow.prepare(setup.lang);
    return () => { disposed = true; stop(); };
  }, [setup]);
  return { flow: setup.flow, log, clearLog: () => setLog('') };
}

/** The local install. Once connected it hands off to the SPA: provider setup after a fresh install. */
export function LocalSetupScreen({ otherOptions, leave = page => window.location.replace(page) }: {
  otherOptions: () => void;
  leave?: (page: string) => void;
}) {
  const setup = useLocalSetup();
  const state = useSyncExternalStore(setup.flow.subscribe, setup.flow.snapshot);
  const leaveRef = useRef(leave);
  leaveRef.current = leave;
  useEffect(() => {
    if (state.stage !== 'ready' || !state.destination) return;
    const destination = state.destination;
    const timer = setTimeout(() => leaveRef.current(destination), state.warning ? 3500 : 600);
    return () => clearTimeout(timer);
  }, [state.stage, state.destination, state.warning]);

  return <LocalSetupView {...setup} otherOptions={otherOptions} />;
}
