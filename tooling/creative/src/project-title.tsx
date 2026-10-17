import { useComputed } from '@preact/signals';
import { render } from 'preact';
import type { StackEditor } from './editing';

const ProjectTitle = ({ editor }: { editor: StackEditor }) => {
  const title = useComputed(() => editor.state.value.project.name);
  return <>{title}</>;
};

/** The title observes the editor independently of the imperative shell redraw. */
export const mountProjectTitle = (
  container: HTMLElement,
  editor: StackEditor,
): (() => void) => {
  render(<ProjectTitle editor={editor} />, container);
  return () => render(null, container);
};
