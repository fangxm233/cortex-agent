// input:  React context/state, auth notice targets, LoginFlowModal
// output: global login modal provider with notice-flow reuse
// pos:    Shares one authentication overlay across desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type { AuthNoticeAction, LoginFlowState } from '@cortex-agent/ui-contract';
import { LoginFlowModal } from './LoginFlowModal';

interface LoginFlowContextValue {
  openLogin: (target?: AuthNoticeAction) => void;
  closeLogin: () => void;
}

interface LoginRequest {
  target: AuthNoticeAction | null;
  initialState: LoginFlowState | null;
}

const LoginFlowContext = createContext<LoginFlowContextValue | null>(null);

export function LoginFlowProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<LoginRequest>({ target: null, initialState: null });
  const noticeStates = useRef(new Map<string, LoginFlowState>());
  const openLogin = useCallback((target?: AuthNoticeAction) => {
    setRequest({
      target: target ?? null,
      initialState: target ? noticeStates.current.get(target.noticeId) ?? null : null,
    });
    setOpen(true);
  }, []);
  const closeLogin = useCallback(() => setOpen(false), []);
  const rememberState = useCallback((state: LoginFlowState) => {
    if (request.target) noticeStates.current.set(request.target.noticeId, state);
  }, [request.target]);
  const value = useMemo(() => ({ openLogin, closeLogin }), [openLogin, closeLogin]);
  return (
    <LoginFlowContext.Provider value={value}>
      {children}
      <LoginFlowModal
        open={open} onClose={closeLogin} target={request.target}
        initialState={request.initialState} onFlowStateChange={rememberState}
      />
    </LoginFlowContext.Provider>
  );
}

export function useOptionalLoginFlow(): LoginFlowContextValue | null {
  return useContext(LoginFlowContext);
}

export function useLoginFlow(): LoginFlowContextValue {
  const value = useOptionalLoginFlow();
  if (!value) throw new Error('useLoginFlow must be used within LoginFlowProvider');
  return value;
}
