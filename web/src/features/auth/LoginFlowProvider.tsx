import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { LoginFlowModal, type LoginFlowTarget } from './LoginFlowModal';

interface LoginFlowContextValue {
  openLogin: (target: LoginFlowTarget) => void;
}

const LoginFlowContext = createContext<LoginFlowContextValue | null>(null);

/**
 * One login dialog for the whole app. It opens on the nested modal layer, so a login started from
 * Settings stacks above it and the user lands back in Accounts when it closes.
 */
export function LoginFlowProvider({ children }: { children: ReactNode }) {
  const [request, setRequest] = useState<{ target: LoginFlowTarget; open: boolean } | null>(null);
  const openLogin = useCallback((target: LoginFlowTarget) => setRequest({ target: { ...target }, open: true }), []);
  const closeLogin = useCallback(() => setRequest(current => (current ? { ...current, open: false } : null)), []);
  const value = useMemo(() => ({ openLogin }), [openLogin]);
  return (
    <LoginFlowContext.Provider value={value}>
      {children}
      <LoginFlowModal open={request?.open ?? false} onClose={closeLogin} target={request?.target ?? null} />
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
