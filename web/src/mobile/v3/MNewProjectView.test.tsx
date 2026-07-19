import { describe, it, expect } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { MNewProjectView } from './MNewProjectView';
import type { MNewProjectCopy } from './m-new-project-vm';

const copy: MNewProjectCopy = {
  title: '新建项目',
  tag: 'projects/',
  placeholder: '项目名字，如 rl-locomotion',
  create: '创建并开始对话',
};

function render(name: string) {
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
  it('renders the title row and the faint projects/ tag', () => {
    const html = render('');
    expect(html).toContain('新建项目');
    expect(html).toContain('projects/');
  });

  it('renders the controlled name input with the placeholder', () => {
    const html = render('');
    expect(html).toContain('项目名字，如 rl-locomotion');
  });

  it('reflects the entered name as the input value', () => {
    const html = render('rl-locomotion');
    expect(html).toContain('value="rl-locomotion"');
  });

  it('does not render the removed hint copy', () => {
    const html = render('');
    expect(html).not.toContain('只创建');
    expect(html).not.toContain('project_init');
  });

  it('renders the create-and-chat button label', () => {
    const html = render('');
    expect(html).toContain('创建并开始对话');
  });

  it('disables the create button when the name is empty', () => {
    expect(render('')).toContain('disabled');
  });

  it('enables the create button once a name is entered', () => {
    expect(render('rl-locomotion')).not.toContain('disabled');
  });
});
