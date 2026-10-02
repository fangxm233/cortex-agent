import { useState, type ReactNode } from 'react';

/** Only navigation moves the content; clipping keeps transforms out of scroll measurements. */
export function SelectionPane({ pane, children }: { pane: string; children: ReactNode }): JSX.Element {
  const [navigation, setNavigation] = useState({ pane, animated: false });
  if (navigation.pane !== pane) setNavigation({ pane, animated: true });
  const direction = pane === 'root' ? 'back' : 'forward';
  return (
    <div className="selection-pane-clip">
      <div key={pane} className="selection-pane" data-pane={pane} data-motion={navigation.animated ? direction : undefined}>
        {children}
      </div>
    </div>
  );
}
