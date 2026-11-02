// Asks the reader whether to run the code a Project's Add-ons carry (ADR
// 0162). It says plainly what trusting means, since a trusted Add-on can
// do anything Folio can.
import { h } from '../dom';
import type { AddOnRef } from '../model';

/** Resolves true when the reader trusts every Add-on in `refs`. */
export const askToTrust = (refs: readonly AddOnRef[]): Promise<boolean> =>
  new Promise(resolve => {
    const dialog = h(
      'dialog',
      { class: 'trust-prompt', 'aria-labelledby': 'trust-prompt-title' },
      h(
        'h2',
        { id: 'trust-prompt-title' },
        refs.length === 1
          ? 'This Project brings its own Add-on'
          : `This Project brings ${refs.length} Add-ons of its own`,
      ),
      h(
        'ul',
        {},
        ...refs.map(ref =>
          h('li', {}, h('code', {}, ref.id), ` version ${ref.version}`),
        ),
      ),
      h(
        'p',
        {},
        'An Add-on runs as part of Folio. Once trusted, it can do anything Folio can, including reading your other Projects. Trust it only if you trust whoever gave you this Project.',
      ),
      h(
        'p',
        { class: 'muted' },
        'If you don’t trust it, the Project still opens and its Add-on Elements show as placeholders.',
      ),
      h(
        'form',
        { method: 'dialog', class: 'trust-prompt-buttons' },
        h(
          'button',
          { value: 'no', type: 'submit', class: 'default' },
          'Don’t trust',
        ),
        h(
          'button',
          { value: 'yes', type: 'submit', 'data-trust': true },
          'Trust and run',
        ),
      ),
    );
    dialog.addEventListener('close', () => {
      dialog.remove();
      resolve(dialog.returnValue === 'yes');
    });
    document.body.append(dialog);
    dialog.showModal();
  });
