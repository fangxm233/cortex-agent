// input:  mutation-returned project id and mobile scope/sheet/navigation actions
// output: ordered completion of mobile project creation
// pos:    Mobile new-project success transition helper
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

interface MobileProjectCreationActions {
  setCurrentProject: (id: string) => void;
  close: () => void;
  navigate: (path: string) => void;
}

/** Scope first so the destination draft session is born under the project the server created. */
export function finishMobileProjectCreation(
  id: string,
  { setCurrentProject, close, navigate }: MobileProjectCreationActions,
): void {
  setCurrentProject(id);
  close();
  navigate('/m/session/new');
}
