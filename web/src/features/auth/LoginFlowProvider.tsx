// input:  React context/state and LoginFlowModal
// output: global login modal provider and opener hook
// pos:    Shares one authentication overlay across desktop and mobile
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { LoginFlowModal } from './LoginFlowModal';

interface LoginFlowContextValue {
  openLogin: () => void;
  closeLogin: () => void;
}

const LoginFlowContext = createContext<LoginFlowContextValue | null>(null);

export function LoginFlowProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const openLogin = useCallback(() => setOpen(true), []);
  const closeLogin = useCallback(() => setOpen(false), []);
  const value = useMemo(() => ({ openLogin, closeLogin }), [openLogin, closeLogin]);
  return (
    <LoginFlowContext.Provider value={value}>
      {children}
      <LoginFlowModal open={open} onClose={closeLogin} />
    </LoginFlowContext.Provider>
  );
}

export function useLoginFlow(): LoginFlowContextValue {
  const value = useContext(LoginFlowContext);
  if (!value) throw new Error('useLoginFlow must be used within LoginFlowProvider');
  return value;
}
