// The Sounds window's Rename… and Remove… dialogs (#2050). Renaming rewrites
// every literal use of the sound; removing lists those uses first, since
// they become missing-sound problems. Either is one edit that Undo reverses.
import { h } from './dom';
import type { SoundUse } from './sound-uses';

const usesList = (uses: readonly SoundUse[]) =>
  h(
    'ul',
    { 'data-sound-uses': '' },
    ...uses.map(use => h('li', {}, `${use.where}, line ${use.line}`)),
  );

/** Asks for a sound's new name; `rename` returns why it can't, if it can't. */
export const showRenameSoundDialog = (options: {
  current: string;
  rename: (name: string) => string | undefined;
  uses: readonly SoundUse[];
}): void => {
  const input = h('input', {
    'aria-label': 'Sound name',
    'data-sound-name-input': '',
    type: 'text',
    value: options.current,
  });
  const problem = h('p', { class: 'error', 'data-sound-name-problem': '' });
  problem.hidden = true;
  const form = h(
    'form',
    { method: 'dialog', class: 'sound-dialog-buttons' },
    h('button', { type: 'submit', value: 'cancel' }, 'Cancel'),
    h(
      'button',
      { type: 'submit', value: 'rename', class: 'default', 'data-rename': '' },
      'Rename',
    ),
  );
  const { length } = options.uses;
  const dialog = h(
    'dialog',
    { class: 'sound-dialog', 'aria-labelledby': 'rename-sound-title' },
    h('h2', { id: 'rename-sound-title' }, `Rename “${options.current}”`),
    input,
    problem,
    h(
      'p',
      { class: 'muted' },
      length
        ? `Folio also renames its ${length === 1 ? 'use' : `${length} uses`} in Scripts and Libraries. A name built while playing isn’t found.`
        : 'No Script or Library names this sound in a pattern text.',
    ),
    form,
  );
  form.addEventListener('submit', event => {
    if ((event.submitter as HTMLButtonElement | null)?.value !== 'rename') {
      return;
    }
    const why = options.rename(input.value);
    if (why) {
      event.preventDefault();
      problem.textContent = why;
      problem.hidden = false;
      input.focus();
    }
  });
  dialog.addEventListener('close', () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
  input.select();
};

/** Confirms removing a sound, listing the uses that will stop loading. */
export const showRemoveSoundDialog = (options: {
  name: string;
  remove: () => void;
  uses: readonly SoundUse[];
}): void => {
  const { length } = options.uses;
  const dialog = h(
    'dialog',
    { class: 'sound-dialog', 'aria-labelledby': 'remove-sound-title' },
    h('h2', { id: 'remove-sound-title' }, `Remove “${options.name}”?`),
    ...(length
      ? [
          h(
            'p',
            {},
            `${length === 1 ? 'This use' : `These ${length} uses`} will be reported as missing sounds:`,
          ),
          usesList(options.uses),
        ]
      : [
          h(
            'p',
            {},
            'No Script or Library names this sound in a pattern text.',
          ),
        ]),
    h(
      'p',
      { class: 'muted' },
      'A name built while playing fails when it plays. Edit ▸ Undo brings the sound back.',
    ),
    h(
      'form',
      { method: 'dialog', class: 'sound-dialog-buttons' },
      h(
        'button',
        { type: 'submit', value: 'cancel', class: 'default' },
        'Cancel',
      ),
      h(
        'button',
        { type: 'submit', value: 'remove', 'data-remove': '' },
        'Remove',
      ),
    ),
  );
  dialog.addEventListener('close', () => {
    dialog.remove();
    if (dialog.returnValue === 'remove') {
      options.remove();
    }
  });
  document.body.append(dialog);
  dialog.showModal();
};
