import type { LayerOrder } from './editing';

export type EditingCommand =
  LayerOrder | 'undo' | 'redo' | 'duplicate' | 'delete' | 'group' | 'ungroup';

type Key = Pick<
  KeyboardEvent,
  'altKey' | 'ctrlKey' | 'key' | 'metaKey' | 'shiftKey'
>;

/** Typing keeps the field's own keyboard behavior, including native undo. */
export const commandForKey = (
  event: Key,
  typing: boolean,
): EditingCommand | undefined => {
  if (typing || event.altKey) {
    return undefined;
  }
  if (event.metaKey || event.ctrlKey) {
    const key = event.key.toLowerCase();
    if (key === 'z') {
      return event.shiftKey ? 'redo' : 'undo';
    }
    if (key === 'g') {
      return event.shiftKey ? 'ungroup' : 'group';
    }
    if (key === 'd' && !event.shiftKey) {
      return 'duplicate';
    }
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    return 'delete';
  }
  return undefined;
};

/**
 * The File menu button a shortcut clicks. Browsers keep ⌘N, ⌘T and ⌘W for
 * themselves, so New Project has none.
 */
export const menuButtonForKey = (event: Key): string | undefined => {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) {
    return undefined;
  }
  const key = event.key.toLowerCase();
  if (key === 's') {
    return event.shiftKey ? 'save-file-as' : 'save-file';
  }
  if (key === 'o') {
    return event.shiftKey ? 'import-project' : 'show-projects';
  }
  return undefined;
};

/** Whether a key toggles Play's Present mode: ⌘↩ or Ctrl+Enter. */
export const isPlayKey = (event: Key): boolean =>
  (event.metaKey || event.ctrlKey) &&
  !event.altKey &&
  !event.shiftKey &&
  event.key === 'Enter';
