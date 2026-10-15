import { useEffect, useState } from 'react';
import { useVocab } from '@/i18n';
import { nativeErrorMessage } from '@/lib/native-error';
import type { NativeUninstallInfo, NativeUninstallStep } from '@/lib/native-bridge';
import { MonitorIcon } from '@/features/provider-setup/onboarding-icons';
import {
  STATUS_LABEL, STATUS_LOOK, STEP_LABEL, dataHint, dataPaths, defaultScope, manualLocation, resultIntro,
  runResult, shownSteps, type ShownStatus, type UninstallPorts, type UninstallScope,
} from './uninstall-flow';

const STATUS_ICON: Partial<Record<ShownStatus, string>> = { done: '✓', failed: '!' };

type Stage = { kind: 'choose' } | { kind: 'running' } | { kind: 'result'; steps: NativeUninstallStep[] };

function useUninstall(ports: UninstallPorts) {
  const [info, setInfo] = useState<NativeUninstallInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scope, setScope] = useState<UninstallScope>('server');
  const [deleteData, setDeleteData] = useState(false);
  const [stage, setStage] = useState<Stage>({ kind: 'choose' });
  useEffect(() => {
    void ports.info().then(
      (value) => { setInfo(value); setScope(defaultScope(value)); },
      (cause: unknown) => setError(nativeErrorMessage(cause)),
    );
  }, [ports]);
  const start = async () => {
    setError(null);
    setStage({ kind: 'running' });
    try {
      setStage({ kind: 'result', steps: await ports.run(scope, deleteData) });
    } catch (cause) {
      setError(nativeErrorMessage(cause));
      setStage({ kind: 'choose' });
    }
  };
  const back = () => setStage({ kind: 'choose' });
  return { info, error, scope, setScope, deleteData, setDeleteData, stage, start, back };
}

type Flow = ReturnType<typeof useUninstall>;

/** The uninstaller window's content: choose → uninstalling → what happened. */
export function UninstallScreen({ ports }: { ports: UninstallPorts }) {
  const flow = useUninstall(ports);
  const { info, stage } = flow;
  return <>
    {info && stage.kind === 'choose' ? <ChooseSection info={info} flow={flow} ports={ports} /> : null}
    {stage.kind === 'running' ? <RunningSection /> : null}
    {info && stage.kind === 'result' ? <ResultSection info={info} steps={stage.steps} flow={flow} ports={ports} /> : null}
    {flow.error ? <div className="onb-error-box" role="alert"><p>{flow.error}</p></div> : null}
  </>;
}

function ScopeOption({ value, flow, title, desc }: { value: UninstallScope; flow: Flow; title: string; desc: string }) {
  return <label className="uninst-option">
    <input type="radio" name="uninstall-scope" value={value} checked={flow.scope === value}
      onChange={() => flow.setScope(value)} />
    <div><strong>{title}</strong><p className="setup-hint">{desc}</p></div>
  </label>;
}

function ChooseSection({ info, flow, ports }: { info: NativeUninstallInfo; flow: Flow; ports: UninstallPorts }) {
  const L = useVocab();
  const paths = flow.deleteData ? dataPaths(info, flow.scope) : [];
  return <section>
    <div className="setup-eyebrow">{L.uninstHeader}</div>
    <h1>{L.uninstTitle}</h1>
    <p className="setup-intro">{L.uninstIntro}</p>
    <div className="setup-card">
      <div className="setup-card-header"><MonitorIcon /><h2>{L.uninstScopeHeading}</h2></div>
      <div className="setup-card-body">
        {info.localServer ? <div role="radiogroup" aria-label={L.uninstScopeHeading}>
          <ScopeOption value="server" flow={flow} title={L.uninstScopeServer} desc={L.uninstScopeServerDesc} />
          <ScopeOption value="app" flow={flow} title={L.uninstScopeApp} desc={L.uninstScopeAppDesc} />
        </div> : <div className="onb-notice">{L.uninstNoLocalServer}</div>}
        <label className="onb-toggle-row">
          <div><strong>{L.uninstDeleteData}</strong><p className="setup-hint">{L[dataHint(info, flow.scope, flow.deleteData)]}</p></div>
          <input className="onb-toggle" type="checkbox" data-action="uninstall-delete-data" checked={flow.deleteData}
            onChange={event => flow.setDeleteData(event.target.checked)} />
        </label>
        {paths.length ? <div className="uninst-paths">{L.uninstWillDelete}{paths.map(p => <code key={p}>{p}</code>)}</div> : null}
      </div>
      <div className="uninst-actions">
        <button type="button" className="setup-button" onClick={() => void ports.exit(false)}>{L.uninstCancel}</button>
        <button type="button" className="setup-button uninst-danger" data-action="uninstall-confirm"
          onClick={() => void flow.start()}>{L.uninstConfirm}</button>
      </div>
    </div>
  </section>;
}

function RunningSection() {
  const L = useVocab();
  return <section>
    <div className="setup-eyebrow">{L.uninstHeader}</div>
    <h1>{L.uninstRunning}</h1>
    <div className="setup-card"><div className="onb-progress-body" role="status" aria-live="polite">
      <div className="onb-status-row" data-status="running">
        <span className="onb-status-icon" aria-hidden="true" /><div><strong>{L.uninstRunning}</strong></div>
      </div>
    </div></div>
  </section>;
}

function StepRows({ steps }: { steps: NativeUninstallStep[] }) {
  const L = useVocab();
  const rows = shownSteps(steps);
  if (!rows.length) return null;
  return <div className="setup-card"><div className="onb-progress-body">
    {rows.map(row => <div key={row.step} className="onb-status-row" data-status={STATUS_LOOK[row.status]}>
      <span className="onb-status-icon" aria-hidden="true">{STATUS_ICON[row.status] ?? ''}</span>
      <div><strong>{L[STEP_LABEL[row.step]]}</strong>{row.detail ? <p className="uninst-detail">{row.detail}</p> : null}</div>
      <span className="onb-status-value">{L[STATUS_LABEL[row.status]]}</span>
    </div>)}
  </div></div>;
}

function ResultSection({ info, steps, flow, ports }: {
  info: NativeUninstallInfo; steps: NativeUninstallStep[]; flow: Flow; ports: UninstallPorts;
}) {
  const L = useVocab();
  const result = runResult(steps);
  const location = manualLocation(info, result);
  return <section>
    <div className="setup-eyebrow">{L.uninstHeader}</div>
    <h1>{result === 'done' ? L.uninstDoneTitle : L.uninstFailedTitle}</h1>
    <p className="setup-intro">{L[resultIntro(info, result)]}{location ? <code className="uninst-location">{location}</code> : null}</p>
    <StepRows steps={steps} />
    <div className="uninst-actions uninst-result-actions">
      {result === 'failed' ? <>
        <button type="button" className="setup-button" onClick={flow.back}>{L.uninstBack}</button>
        <button type="button" className="setup-button setup-primary" onClick={() => void flow.start()}>{L.uninstRetry}</button>
      </> : <button type="button" className="setup-button setup-primary" data-action="uninstall-done"
        onClick={() => void ports.exit(true)}>{L.uninstDone}</button>}
    </div>
  </section>;
}
