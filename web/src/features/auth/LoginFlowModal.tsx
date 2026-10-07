import '@/design/content-surfaces.css';
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react';
import type { LoginFlowNotice, LoginFlowState } from '@cortex-agent/ui-contract';
import { Button, MBottomSheet, Modal, Select } from '@/design';
import { useClipboardFeedback } from '@/design/useClipboardFeedback';
import { fmt, useVocab, type Vocab } from '@/i18n';
import { openExternalUrl } from '@/lib/external-navigation';
import { useMobileLayout } from '@/lib/use-mobile-layout';
import { ProviderIcon } from './ProviderIcon';
import {
  authTypeLabel,
  buildLoginFlowVm,
  canSubmitPrompt,
  deviceCodeRemaining,
  formatClock,
  type LoginFlowVm,
} from './login-flow-vm';
import {
  useLoginFlowController,
  useProviderLabel,
  type LoginFlowController,
  type LoginFlowTarget,
} from './useLoginFlowController';

export type { LoginFlowTarget } from './useLoginFlowController';

export interface LoginFlowModalProps {
  open: boolean;
  onClose: () => void;
  target: LoginFlowTarget | null;
  /** Called once when the flow finishes successfully. */
  onDone?: (state: LoginFlowState) => void;
}

type PendingPrompt = NonNullable<LoginFlowState['pendingPrompt']>;

const IN_PROGRESS = new Set<LoginFlowVm['kind']>(['starting', 'running', 'notice', 'prompt']);

function Spinner() {
  return (
    <span aria-hidden="true"
      className="inline-block h-3.5 w-3.5 flex-none animate-spin rounded-full border-2 border-proto-line-3 border-t-state-run motion-reduce:animate-none" />
  );
}

function StatusLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" data-auth-status className="flex min-w-0 items-center gap-1g break-words text-proto-muted">
      <Spinner /><span className="min-w-0">{children}</span>
    </p>
  );
}

function OpenUrlButton({ href, children, action, primary }: {
  href: string; children: string; action?: string; primary?: boolean;
}) {
  return (
    <Button data-action={action} data-auth-external-url={href} size="sm"
      variant={primary ? 'primary' : 'secondary'} onClick={() => openExternalUrl(href)}>
      {children}<span aria-hidden="true">↗</span>
    </Button>
  );
}

function CopyButton({ text, action, copyKey, clipboard }: {
  text: string; action: string; copyKey: string;
  clipboard: ReturnType<typeof useClipboardFeedback<string>>;
}) {
  const L = useVocab();
  return (
    <Button data-action={action} size="sm" variant="secondary"
      onClick={() => { void clipboard.copy(text, copyKey); }}>
      {clipboard.copiedKey === copyKey ? L.authLoginCopied : L.authLoginCopy}
    </Button>
  );
}

const STEP_BADGE =
  'flex h-5 w-5 flex-none items-center justify-center rounded-full bg-state-run text-[11px] font-semibold text-[var(--accent-fg)]';

function Step({ index, children, data }: { index: number; children: ReactNode; data: string }) {
  return (
    <section {...{ [data]: true }} className="flex min-w-0 items-start gap-1.5g py-1.5g first:pt-0 [&+&]:border-t [&+&]:border-proto-line-2">
      <span className={STEP_BADGE}>{index}</span>
      <div className="min-w-0 flex-1 space-y-1g break-words">{children}</div>
    </section>
  );
}

function AuthUrlStep({ notice, waiting }: {
  notice: Extract<LoginFlowNotice, { kind: 'auth_url' }>;
  /** No prompt follows: the provider finishes on its own once the browser step is done. */
  waiting: boolean;
}) {
  const L = useVocab();
  const clipboard = useClipboardFeedback<string>();
  return (
    <Step index={1} data="data-auth-open-step">
      <p className="font-medium text-state-ink">{L.authLoginOpenStep}</p>
      <div data-auth-notice="auth_url" className="flex flex-wrap gap-1g">
        <OpenUrlButton href={notice.url} action="auth-open-url" primary={waiting}>
          {L.authLoginOpenAuthorization}
        </OpenUrlButton>
        <CopyButton text={notice.url} action="auth-copy-url" copyKey="url" clipboard={clipboard} />
      </div>
      {waiting ? <StatusLine>{notice.instructions ?? L.authLoginWaitingBrowser}</StatusLine> : null}
    </Step>
  );
}

function useCountdown(notice: Extract<LoginFlowNotice, { kind: 'device_code' }>): number | null {
  const shownAt = useRef<{ code: string; at: number } | null>(null);
  if (shownAt.current?.code !== notice.userCode) shownAt.current = { code: notice.userCode, at: Date.now() };
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (notice.expiresInSeconds === undefined) return undefined;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [notice.expiresInSeconds]);
  if (notice.expiresInSeconds === undefined) return null;
  return deviceCodeRemaining(notice.expiresInSeconds, shownAt.current.at, now);
}

function DeviceCodeNotice({ notice }: { notice: Extract<LoginFlowNotice, { kind: 'device_code' }> }) {
  const L = useVocab();
  const clipboard = useClipboardFeedback<string>();
  const remaining = useCountdown(notice);
  const expiry = remaining === null ? null
    : remaining > 0 ? fmt(L.authLoginExpiresIn, { time: formatClock(remaining) }) : L.authLoginCodeExpired;
  return (
    <div data-auth-notice="device_code" className="min-w-0 space-y-1.5g">
      <p className="text-state-ink">{L.authLoginDeviceStep}</p>
      <div className="flex min-w-0 flex-wrap items-center gap-1.5g rounded-[var(--r-card)] border border-dashed border-proto-accent-border bg-proto-accent-bg px-2g py-1.5g">
        <span data-auth-device-code className="min-w-0 flex-1 break-all font-mono text-xl font-semibold tracking-wider text-state-ink">
          {notice.userCode}
        </span>
        <CopyButton text={notice.userCode} action="auth-copy-code" copyKey="code" clipboard={clipboard} />
        <OpenUrlButton href={notice.verificationUri} action="auth-open-verification" primary>
          {L.authLoginOpenVerification}
        </OpenUrlButton>
      </div>
      <StatusLine>
        {expiry ? `${L.authLoginWaitingBrowser} · ${expiry}` : L.authLoginWaitingBrowser}
      </StatusLine>
    </div>
  );
}

function InfoNotice({ notice, L }: { notice: Extract<LoginFlowNotice, { kind: 'info' }>; L: Vocab }) {
  return (
    <div data-auth-notice="info" className="min-w-0 space-y-1g break-words">
      <p>{notice.message}</p>
      {(notice.links ?? []).length > 0 ? (
        <div className="flex flex-wrap gap-1g">
          {(notice.links ?? []).map(link => (
            <OpenUrlButton key={link.url} href={link.url}>{link.label ?? L.authLoginOpenLink}</OpenUrlButton>
          ))}
        </div>
      ) : null}
    </div>
  );
}

/** A notice shown on its own (no prompt beside it). */
function StandaloneNotice({ notice }: { notice: LoginFlowNotice }) {
  const L = useVocab();
  if (notice.kind === 'device_code') return <DeviceCodeNotice notice={notice} />;
  if (notice.kind === 'auth_url') return <AuthUrlStep notice={notice} waiting />;
  if (notice.kind === 'info') return <><InfoNotice notice={notice} L={L} /><StatusLine>{L.authLoginRunning}</StatusLine></>;
  return <div data-auth-notice="progress"><StatusLine>{notice.message}</StatusLine></div>;
}

// `border-solid` is needed: the global base rule strips input borders. Focus uses the
// content-surface outline shared by every dialog control.
const INPUT_CLASS =
  'box-border min-h-9 w-full min-w-0 rounded-[var(--r-control)] border border-solid border-proto-line-3 ' +
  '[background:var(--material-control-bg)] px-1.5g py-1g text-ui text-state-ink ' +
  'placeholder:text-proto-muted-3 focus-visible:border-proto-accent';

function PromptSelect({ prompt, value, onChange }: {
  prompt: PendingPrompt; value: string; onChange: (value: string) => void;
}) {
  const isMobile = useMobileLayout();
  const options = (prompt.options ?? []).map(option => ({
    value: option.id, label: option.label, description: option.description,
  }));
  if (!isMobile) {
    // The option labels are the provider's own sentences, so the popup uses the dialog's font.
    return <Select data-auth-select density="bare" aria-labelledby="auth-login-prompt-label"
      value={value} options={options} onValueChange={onChange} className={INPUT_CLASS}
      popupClassName="![font-family:inherit] !text-ui" />;
  }
  return (
    <select data-auth-select aria-labelledby="auth-login-prompt-label" value={value}
      onChange={event => onChange(event.target.value)} className={INPUT_CLASS}>
      {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select>
  );
}

function PromptInput({ prompt, value, onChange, onSubmit }: {
  prompt: PendingPrompt; value: string; onChange: (value: string) => void; onSubmit: () => void;
}) {
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Enter' || event.nativeEvent.isComposing) return;
    event.preventDefault();
    onSubmit();
  };
  if (prompt.kind === 'select') return <PromptSelect prompt={prompt} value={value} onChange={onChange} />;
  return (
    <input data-auth-input={prompt.kind} aria-labelledby="auth-login-prompt-label" autoFocus
      type={prompt.kind === 'secret' ? 'password' : 'text'} value={value}
      autoComplete={prompt.kind === 'manual_code' ? 'one-time-code' : 'off'} spellCheck={false}
      placeholder={prompt.placeholder} onKeyDown={onKeyDown}
      onChange={event => onChange(event.target.value)} className={INPUT_CLASS} />
  );
}

function PromptField({ prompt, value, onChange, onSubmit }: {
  prompt: PendingPrompt; value: string; onChange: (value: string) => void; onSubmit: () => void;
}) {
  return (
    <label className="block min-w-0 space-y-1g">
      <span id="auth-login-prompt-label" data-auth-prompt-copy className="block break-words font-medium text-state-ink">
        {prompt.message}
      </span>
      <PromptInput prompt={prompt} value={value} onChange={onChange} onSubmit={onSubmit} />
    </label>
  );
}

function PromptBody({ state, value, onChange, onSubmit }: {
  state: LoginFlowState; value: string; onChange: (value: string) => void; onSubmit: () => void;
}) {
  const prompt = state.pendingPrompt!;
  const notice = state.notice;
  const field = <PromptField prompt={prompt} value={value} onChange={onChange} onSubmit={onSubmit} />;
  if (notice?.kind === 'auth_url') {
    return (
      <div className="min-w-0">
        <AuthUrlStep notice={notice} waiting={false} />
        <Step index={2} data="data-auth-code-step">{field}</Step>
      </div>
    );
  }
  return (
    <div className="min-w-0 space-y-2g">
      {notice ? <StandaloneNoticeForPrompt notice={notice} /> : null}
      {field}
    </div>
  );
}

/** A notice that accompanies a prompt: no waiting spinner, the prompt is what the user acts on. */
function StandaloneNoticeForPrompt({ notice }: { notice: LoginFlowNotice }) {
  const L = useVocab();
  if (notice.kind === 'info') return <InfoNotice notice={notice} L={L} />;
  if (notice.kind === 'device_code') return <DeviceCodeNotice notice={notice} />;
  if (notice.kind === 'progress') return <p data-auth-notice="progress" className="text-proto-muted">{notice.message}</p>;
  return null;
}

function FlowError({ title, detail }: { title?: string; detail?: string }) {
  return (
    <div data-auth-error role="alert"
      className="min-w-0 rounded-[var(--r-card)] border border-state-fail/20 bg-pill-failed-bg px-1.5g py-1g text-state-fail">
      {title ? <p className="font-medium">{title}</p> : null}
      {detail ? <p data-auth-error-detail className="mt-0.5 max-h-40 overflow-y-auto break-words text-[12px] [overflow-wrap:anywhere]">{detail}</p> : null}
    </div>
  );
}

function usePromptValue(prompt: PendingPrompt | null): [string, (value: string) => void] {
  const [entry, setEntry] = useState<{ id: number | null; value: string }>({ id: null, value: '' });
  const id = prompt?.id ?? null;
  const fallback = prompt?.kind === 'select' ? prompt.options?.[0]?.id ?? '' : '';
  const value = entry.id === id ? entry.value : fallback;
  return [value, next => setEntry({ id, value: next })];
}

function LoginBody({ vm, controller, value, setValue, submit }: {
  vm: LoginFlowVm; controller: LoginFlowController;
  value: string; setValue: (value: string) => void; submit: () => void;
}) {
  const state = controller.latest;
  const content: Record<LoginFlowVm['kind'], () => ReactNode> = {
    starting: () => <StatusLine>{vm.message}</StatusLine>,
    running: () => <StatusLine>{vm.message}</StatusLine>,
    notice: () => (state?.notice ? <StandaloneNotice notice={state.notice} /> : null),
    prompt: () => (state ? <PromptBody state={state} value={value} onChange={setValue} onSubmit={submit} /> : null),
    done: () => (
      <p data-auth-success role="status"
        className="rounded-[var(--r-card)] bg-pill-done-bg px-1.5g py-1g font-medium text-state-done">{vm.message}</p>
    ),
    failed: () => <FlowError title={vm.message} detail={vm.detail} />,
    cancelled: () => <p data-auth-cancelled className="break-words text-proto-muted">{vm.message}</p>,
  };
  return (
    <div data-auth-flow-step={vm.kind} className="min-w-0 space-y-2g">
      {controller.respondError && vm.kind === 'prompt' ? <FlowError detail={controller.respondError} /> : null}
      {content[vm.kind]()}
    </div>
  );
}

function LoginFooter({ vm, controller, canSubmit, submit, close, L }: {
  vm: LoginFlowVm; controller: LoginFlowController; canSubmit: boolean;
  submit: () => void; close: () => void; L: Vocab;
}) {
  const cancel = <Button data-action="auth-cancel" onClick={close}>{L.cancel}</Button>;
  if (vm.kind === 'done') {
    return <Button data-action="auth-done" variant="primary" onClick={close}>{L.authLoginDone}</Button>;
  }
  if (vm.kind === 'failed' || vm.kind === 'cancelled') {
    return <>
      <Button data-action="auth-close" onClick={close}>{L.authLoginClose}</Button>
      <Button data-action="auth-retry" variant="primary" onClick={controller.retry}>{L.authLoginRetry}</Button>
    </>;
  }
  if (vm.kind !== 'prompt') return cancel;
  return <>
    {cancel}
    <Button data-action="auth-submit" variant="primary" disabled={!canSubmit || controller.responding} onClick={submit}>
      {controller.responding ? <Spinner /> : null}{L.authLoginSubmit}
    </Button>
  </>;
}

function LoginTitle({ target, label, L }: { target: LoginFlowTarget | null; label: string | null; L: Vocab }) {
  const icon = target?.backend === 'claude' ? 'claude-code' : target?.provider ?? '';
  return (
    <span className="flex min-w-0 items-center gap-1g">
      {target ? <ProviderIcon provider={icon} label={label ?? ''} size={18} /> : null}
      <span data-auth-title className="min-w-0 break-words font-semibold text-state-ink">
        {label ? fmt(L.authLoginTitle, { provider: label }) : L.authLoginTitleGeneric}
      </span>
      {target ? (
        <span data-auth-subtitle className="flex-none text-[12px] font-normal text-proto-muted">
          {authTypeLabel(target.backend, target.authType, L)}
        </span>
      ) : null}
    </span>
  );
}

function MobileLoginSheet({ title, titleText, body, footer, inProgress, onClose, closeLabel }: {
  title: ReactNode; titleText: string; body: ReactNode; footer: ReactNode;
  inProgress: boolean; onClose: () => void; closeLabel: string;
}) {
  return (
    <MBottomSheet onClose={onClose} dimDismiss={!inProgress}>
      <section data-auth-sheet role="dialog" aria-modal="true" aria-label={titleText}
        className="content-surface flex min-w-0 flex-col">
        <header className="flex flex-none items-center justify-between gap-2g pb-2g">
          <h2 className="min-w-0 text-body">{title}</h2>
          <button type="button" aria-label={closeLabel} data-action="auth-dismiss" onClick={onClose}
            className="flex h-8 w-8 flex-none items-center justify-center rounded-full [background:var(--material-control-bg)] shadow-[shadow:var(--material-control-shadow)] text-state-ink/70">✕</button>
        </header>
        <div className="min-w-0 pb-2g">{body}</div>
        <footer className="flex flex-none flex-wrap gap-1g border-t border-card pt-2g [&>*]:flex-1">{footer}</footer>
      </section>
    </MBottomSheet>
  );
}

export function LoginFlowModal({ open, onClose, target, onDone }: LoginFlowModalProps) {
  const L = useVocab();
  const isMobile = useMobileLayout();
  const label = useProviderLabel(open, target);
  const controller = useLoginFlowController(open, target, onDone);
  const vm = buildLoginFlowVm({ state: controller.latest, label: label ?? '', startError: controller.startError }, L);
  const prompt = vm.kind === 'prompt' ? controller.latest?.pendingPrompt ?? null : null;
  const [value, setValue] = usePromptValue(prompt);
  const canSubmit = !!prompt && canSubmitPrompt(prompt, value);
  const submit = () => { if (canSubmit && !controller.responding) controller.respond(value); };
  const inProgress = IN_PROGRESS.has(vm.kind);
  const title = <LoginTitle target={target} label={label} L={L} />;
  const titleText = label ? fmt(L.authLoginTitle, { provider: label }) : L.authLoginTitleGeneric;
  const body = <LoginBody vm={vm} controller={controller} value={value} setValue={setValue} submit={submit} />;
  const footer = <LoginFooter vm={vm} controller={controller} canSubmit={canSubmit} submit={submit} close={onClose} L={L} />;
  if (isMobile) {
    return open ? <MobileLoginSheet title={title} titleText={titleText} body={body} footer={footer}
      inProgress={inProgress} onClose={onClose} closeLabel={L.authLoginClose} /> : <></>;
  }
  return (
    <Modal contentClassName="content-surface" layer="nested" open={open}
      onOpenChange={next => { if (!next) onClose(); }}
      // A click beside an unfinished login is not a decision to abandon it; × and Cancel are.
      onPointerDownOutside={event => { if (inProgress) event.preventDefault(); }}
      onOpenAutoFocus={event => { event.preventDefault(); (event.target as HTMLElement | null)?.focus?.(); }}
      contentDataAttributes={{ 'data-auth-dialog': true }}
      title={title} description={vm.detail ?? vm.message} hideDescription footer={footer}>
      {body}
    </Modal>
  );
}
