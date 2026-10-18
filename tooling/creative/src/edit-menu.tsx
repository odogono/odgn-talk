import type { ReadonlySignal } from '@preact/signals';
import { Fragment, render } from 'preact';
import type { StackEditor } from './editing';
import type { EditingCommand } from './shortcuts';
import type { PlayMode } from './stack';

type EditMenuProps = {
  editor: StackEditor;
  playing: ReadonlySignal<PlayMode | undefined>;
};

/**
 * Whether a command can run now. Read-only disables every command, and
 * Browse hides the Page, so only Script edits can be undone or redone.
 */
const enabled = (
  { editor, playing }: EditMenuProps,
  command: EditingCommand,
): boolean => {
  if (editor.readOnly) {
    return false;
  }
  if (command === 'undo') {
    return editor.canUndo;
  }
  if (command === 'redo') {
    return editor.canRedo;
  }
  if (playing.value === 'browse') {
    return false;
  }
  if (command === 'group') {
    return editor.canGroup;
  }
  if (command === 'ungroup') {
    return editor.canUngroup;
  }
  if (command === 'delete') {
    return editor.canDelete;
  }
  return command === 'duplicate' || editor.selection.length > 0;
};

const EditMenu = (props: EditMenuProps) => {
  const command = (command: EditingCommand, label: string, keys?: string) => (
    <button
      data-command={command}
      disabled={!enabled(props, command)}
      type="button"
    >
      {label}
      {keys ? (
        <Fragment>
          {' '}
          <kbd>{keys}</kbd>
        </Fragment>
      ) : null}
    </button>
  );
  return (
    <Fragment>
      {command('undo', 'Undo', '⌘Z')}
      {command('redo', 'Redo', '⇧⌘Z')}
      <hr />
      {command('duplicate', 'Duplicate', '⌘D')}
      {command('delete', 'Delete', '⌫')}
      <hr />
      {command('group', 'Group', '⌘G')}
      {command('ungroup', 'Ungroup', '⇧⌘G')}
      <hr />
      {command('forward', 'Bring forward')}
      {command('backward', 'Send backward')}
      {command('front', 'Bring to front')}
      {command('back', 'Send to back')}
    </Fragment>
  );
};

/**
 * The Edit menu's commands, enabled from the editor's signals and the Play
 * mode. Clicks and shortcuts are handled by the shell.
 */
export const mountEditMenu = (
  container: HTMLElement,
  props: EditMenuProps,
): (() => void) => {
  render(<EditMenu {...props} />, container);
  return () => render(null, container);
};
