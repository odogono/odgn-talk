// Project ▸ Add Sound from Music… (#2027): copies sounds the Music Base
// Project brings into this Project (ADR 0161). It stays open, so several
// can be added, and offers only the sounds the Project lacks.
import { h } from './dom';

export type MusicSoundsDialogOptions = {
  /** Copies one sound into the Project. */
  add: (key: string) => Promise<void>;
  /** The Music sounds the Project doesn't have yet, by name. */
  missing: () => readonly string[];
  /** Whether the Project can't change, such as while presenting. */
  readOnly: () => boolean;
};

/** Opens the dialog; it closes on Done or Escape. */
export const showMusicSoundsDialog = (
  options: MusicSoundsDialogOptions,
): void => {
  const list = h('select', {
    'aria-label': 'Music sounds',
    'data-music-sounds': '',
    size: 10,
  });
  const add = h(
    'button',
    { type: 'button', 'data-add-music-sound': '' },
    'Add',
  );
  const empty = h(
    'p',
    { class: 'muted' },
    'This Project has every Music sound.',
  );
  const draw = () => {
    const missing = options.missing();
    const chosen = list.value;
    list.replaceChildren(
      ...missing.map(key => h('option', { value: key }, key)),
    );
    list.value = missing.includes(chosen) ? chosen : (missing[0] ?? '');
    list.hidden = !missing.length;
    empty.hidden = missing.length > 0;
    add.disabled = options.readOnly() || !missing.length;
  };
  const addChosen = () => {
    const key = list.value;
    if (!key || add.disabled) {
      return;
    }
    add.disabled = true;
    void options.add(key).finally(draw);
  };
  add.addEventListener('click', addChosen);
  list.addEventListener('dblclick', addChosen);
  const dialog = h(
    'dialog',
    { class: 'music-sounds-dialog', 'aria-labelledby': 'music-sounds-title' },
    h('h2', { id: 'music-sounds-title' }, 'Add Sound from Music'),
    h(
      'p',
      { class: 'muted' },
      'Copies a sound the Music Base Project brings into this Project, so Scripts can play it by name.',
    ),
    list,
    empty,
    h(
      'form',
      { method: 'dialog', class: 'music-sounds-buttons' },
      add,
      h('button', { type: 'submit', class: 'default' }, 'Done'),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  draw();
  document.body.append(dialog);
  dialog.showModal();
};
