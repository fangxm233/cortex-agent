// input:  React state, notice/settings targets, LoginFlowModal
// output: global targeted login modal with notice-flow reuse
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
import type { LoginFlowState } from '@cortex-agent/ui-contract';
import { LoginFlowModal, type LoginFlowTarget } from './LoginFlowModal';

interface LoginFlowContextValue {
  openLogin: (target?: LoginFlowTarget) => void;
  closeLogin: () => void;
}

interface LoginRequest {
  target: LoginFlowTarget | null;
  initialState: LoginFlowState | null;
}

const LoginFlowContext = createContext<LoginFlowContextValue | null>(null);

export function LoginFlowProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [request, setRequest] = useState<LoginRequest>({ target: null, initialState: null });
  const noticeStates = useRef(new Map<string, LoginFlowState>());
  const openLogin = useCallback((target?: LoginFlowTarget) => {
    setRequest({
      target: target ?? null,
      initialState: target?.noticeId ? noticeStates.current.get(target.noticeId) ?? null : null,
    });
    setOpen(true);
  }, []);
  const closeLogin = useCallback(() => setOpen(false), []);
  const rememberState = useCallback((state: LoginFlowState) => {
    if (request.target?.noticeId) noticeStates.current.set(request.target.noticeId, state);
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
