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
