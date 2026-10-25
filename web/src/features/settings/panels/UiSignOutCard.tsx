import { useVocab } from '@/i18n';
import type { UiSignOut } from '@/features/settings/controllers/useUiSignOut';
import { SLinkAction, SRow } from '@/features/settings/ui/settings-ui';

/** Sign-out for a browser signed in with the UI token; hidden everywhere else. */
export function UiSignOutRow({ controller }: { controller: UiSignOut }) {
  const L = useVocab();
  if (!controller.offered) return null;
  // The action is the whole row: there is no second line of copy for it to sit beside.
  return (
    <SRow title={
      <SLinkAction tone="danger" data-ui-sign-out onClick={() => void controller.signOut()}>
        {L.uiLogoutAction}
      </SLinkAction>
    } />
  );
}
