import type { LayerOrder } from './editing';

export type EditingCommand =
  LayerOrder | 'undo' | 'redo' | 'duplicate' | 'delete';

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
    if (key === 'd' && !event.shiftKey) {
      return 'duplicate';
    }
  } else if (event.key === 'Delete' || event.key === 'Backspace') {
    return 'delete';
  }
  return undefined;
};
