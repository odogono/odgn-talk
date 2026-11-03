// Project ▸ Add-ons… (#2025): the Add-ons a Project lists, as a tick list.
// Ticking a built-in Add-on loads and lists it, so its kinds appear in
// Tools and Info; unticking one is refused while anything uses it. A
// Project Add-on shows its trust state and can only be removed.
import { h } from '../dom';
import type { AddOnRef } from '../model';
import type { DeepReadonly } from '../readonly';
import type { CatalogueEntry } from './catalogue';

export type AddOnsDialogOptions = {
  /** Loads and lists a built-in Add-on; why it couldn't, else undefined. */
  add: (entry: CatalogueEntry) => Promise<string | undefined>;
  /** The Add-ons the Project lists now. */
  addOns: () => DeepReadonly<AddOnRef[]> | undefined;
  catalogue: readonly CatalogueEntry[];
  /** Whether the Project can't change, such as while presenting. */
  readOnly: () => boolean;
  /** Stops listing an Add-on; why it couldn't, else undefined. */
  remove: (id: string) => string | undefined;
  /** Whether the reader trusts a Project Add-on, by its hash. */
  trusted: (hash: string) => boolean;
};

/** What an Add-on brings, as its row says. */
const brings = (entry: CatalogueEntry): string =>
  [...entry.kinds, ...(entry.instruments ?? [])].map(k => k.label).join(', ');

/** Opens the dialog; it closes on Done or Escape. */
export const showAddOnsDialog = (options: AddOnsDialogOptions): void => {
  const list = h('ul', { class: 'add-ons-list' });
  const status = h('p', { class: 'add-ons-status', role: 'status' });
  const row = (
    id: string,
    label: string,
    detail: string,
    checked: boolean,
    toggle: (on: boolean) => Promise<string | undefined>,
    canAdd: boolean,
  ) => {
    const box = h('input', {
      type: 'checkbox',
      'data-add-on': id,
    }) as HTMLInputElement;
    box.checked = checked;
    box.disabled = options.readOnly() || (!checked && !canAdd);
    box.addEventListener('change', () => {
      const on = box.checked;
      box.disabled = true;
      status.textContent = '';
      void toggle(on).then(problem => {
        if (problem) {
          status.textContent = problem;
        }
        draw();
      });
    });
    return h(
      'li',
      {},
      h(
        'label',
        { class: 'check' },
        box,
        h('strong', {}, label),
        ' ',
        h('code', {}, id),
      ),
      h('p', { class: 'muted' }, detail),
    );
  };
  const draw = () => {
    const listed = options.addOns() ?? [];
    const own = listed.filter(ref => ref.code !== undefined);
    list.replaceChildren(
      ...options.catalogue.map(entry => {
        const ref = listed.find(r => r.id === entry.id && !r.code);
        return row(
          entry.id,
          entry.label,
          `Version ${entry.version}. Adds ${brings(entry)}.`,
          ref !== undefined,
          async on => {
            if (!on) {
              const problem = options.remove(entry.id);
              return problem && `${entry.label} stays: ${problem}.`;
            }
            const problem = await options.add(entry);
            return problem && `${entry.label} didn't load: ${problem}.`;
          },
          true,
        );
      }),
      ...own.map(ref =>
        row(
          ref.id,
          'Project Add-on',
          `Version ${ref.version}, carried in this Project. ${
            options.trusted(ref.hash!) ? 'Trusted.' : 'Not trusted.'
          }`,
          true,
          on => {
            const problem = on ? undefined : options.remove(ref.id);
            return Promise.resolve(problem && `${ref.id} stays: ${problem}.`);
          },
          false,
        ),
      ),
    );
  };
  const dialog = h(
    'dialog',
    { class: 'add-ons-dialog', 'aria-labelledby': 'add-ons-title' },
    h('h2', { id: 'add-ons-title' }, 'Add-ons'),
    h(
      'p',
      { class: 'muted' },
      'The Tools and Info windows offer the kinds of the Add-ons this Project uses.',
    ),
    list,
    status,
    h(
      'form',
      { method: 'dialog', class: 'add-ons-buttons' },
      h('button', { type: 'submit', class: 'default' }, 'Done'),
    ),
  );
  dialog.addEventListener('close', () => dialog.remove());
  draw();
  document.body.append(dialog);
  dialog.showModal();
};
