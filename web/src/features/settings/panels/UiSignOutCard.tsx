import { useVocab } from '@/i18n';
import { useUiSignOut } from '@/features/settings/controllers/useUiSignOut';
import { SLinkAction, SRow, SRowGroup } from '@/features/settings/ui/settings-ui';

export function UiSignOutCard() {
  const L = useVocab();
  const { offered, signOut } = useUiSignOut();
  if (!offered) return null;

  // The action is the whole row: there is no second line of copy for it to sit beside.
  return (
    <SRowGroup>
      <SRow title={
        <SLinkAction tone="danger" data-ui-sign-out onClick={() => void signOut()}>
          {L.uiLogoutAction}
        </SLinkAction>
      } />
    </SRowGroup>
  );
}
