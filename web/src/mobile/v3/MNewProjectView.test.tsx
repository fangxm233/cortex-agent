// input:  empty and non-empty project names
// output: create-action availability
// pos:    Mobile new-project view behavior contract
// >>> If I am updated, update my header comment and the parent folder's CORTEX.md <<<

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MNewProjectView } from './MNewProjectView';
import type { MNewProjectCopy } from './m-new-project-vm';

const copy: MNewProjectCopy = {
  title: 'title',
  tag: 'tag',
  placeholder: 'placeholder',
  create: 'create-action',
};

function render(name: string): string {
  return renderToStaticMarkup(
    <MNewProjectView
      name={name}
      onNameChange={() => {}}
      onCreate={() => {}}
      onClose={() => {}}
      copy={copy}
    />,
  );
}

describe('MNewProjectView', () => {
  it('disables creation for an empty name', () => {
    expect(render('')).toContain('disabled=""');
  });

  it('enables creation for a valid name', () => {
    expect(render('project-name')).not.toContain('disabled=""');
  });
});
