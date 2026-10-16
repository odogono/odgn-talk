// The Play view's side of the `user` Grant: the reader answers the Play
// Session's first unanswered prompt over the Page, and notices appear
// briefly without waiting for anyone.
import { h } from './dom';
import { type PendingPrompt, type PlaySession } from './play';

const NOTICE_MS = 4000;

export type PlayPrompts = {
  /** Takes everything down, as leaving Play does. */
  clear(): void;
  /** Whether `node` belongs to a prompt, whose keys stay with it. */
  contains(node: Node | null): boolean;
  /** Shows the session's first prompt and takes its new notices. */
  draw(session: PlaySession): void;
};

/**
 * Mounts over `over`, a positioned box around the Page. `answered` runs
 * after each answer so the session can resume the Run that asked.
 */
export const mountPlayPrompts = (
  over: HTMLElement,
  answered: () => void,
): PlayPrompts => {
  const backdrop = h('div', { class: 'play-prompt-backdrop', hidden: true });
  const notices = h('div', {
    class: 'play-notices',
    role: 'status',
    'aria-live': 'polite',
  });
  over.append(backdrop, notices);
  let shown: PendingPrompt | undefined;
  let returnFocus: HTMLElement | undefined;

  const answer = (
    prompt: PendingPrompt,
    value: Parameters<PendingPrompt['answer']>[0],
  ) => {
    prompt.answer(value);
    answered();
  };
  // Confirm has no separate cancel: dismissing it is declining.
  const dismiss = (prompt: PendingPrompt) =>
    answer(prompt, prompt.kind === 'confirm' ? false : undefined);

  const build = (prompt: PendingPrompt): HTMLElement => {
    const cancel = h('button', { type: 'button' }, 'Cancel');
    cancel.addEventListener('click', () => dismiss(prompt));
    const ok = h('button', { type: 'submit', class: 'default' }, 'OK');
    const title = h('p', { id: 'play-prompt-title' });
    const form = h(
      'form',
      {
        class: 'play-prompt',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-labelledby': 'play-prompt-title',
      },
      title,
    );
    const buttons = h('div', { class: 'play-prompt-buttons' }, cancel, ok);
    form.addEventListener('keydown', event => {
      if (event.key === 'Escape') {
        event.preventDefault();
        dismiss(prompt);
      }
    });
    if (prompt.kind === 'confirm') {
      title.textContent = prompt.message;
      form.addEventListener('submit', event => {
        event.preventDefault();
        answer(prompt, true);
      });
      form.append(buttons);
      return form;
    }
    if (prompt.kind === 'enter') {
      title.textContent = prompt.message;
      const input = h('input', {
        type: 'text',
        'aria-labelledby': 'play-prompt-title',
      });
      input.value = prompt.fallback;
      form.addEventListener('submit', event => {
        event.preventDefault();
        answer(prompt, input.value);
      });
      form.append(input, buttons);
      return form;
    }
    title.textContent = prompt.prompt || 'Choose';
    const name = 'play-prompt-choice';
    const choices = prompt.items.map(() =>
      h('input', { type: prompt.multiple ? 'checkbox' : 'radio', name }),
    );
    // A single choice needs one picked before OK; none is a valid multiple.
    if (!prompt.multiple) {
      choices[0]!.checked = true;
    }
    const list = h(
      'div',
      { class: 'play-prompt-choices', role: 'group' },
      ...prompt.items.map((item, i) => h('label', {}, choices[i]!, item)),
    );
    form.addEventListener('submit', event => {
      event.preventDefault();
      const picked = prompt.items.filter((_, i) => choices[i]!.checked);
      answer(prompt, prompt.multiple ? picked : picked[0]);
    });
    form.append(list, buttons);
    return form;
  };

  const show = (prompt: PendingPrompt | undefined) => {
    if (prompt === shown) {
      return;
    }
    const hadFocus = backdrop.contains(document.activeElement);
    shown = prompt;
    backdrop.replaceChildren();
    backdrop.hidden = !prompt;
    if (prompt) {
      if (!hadFocus) {
        returnFocus = document.activeElement as HTMLElement | undefined;
      }
      const form = build(prompt);
      backdrop.append(form);
      form.querySelector<HTMLElement>('input, button.default')?.focus();
    } else if (hadFocus) {
      returnFocus?.focus();
      returnFocus = undefined;
    }
  };

  return {
    draw(session) {
      show(session.prompts[0]);
      for (const notice of session.notices.splice(0)) {
        const node = h(
          'div',
          { class: 'play-notice' },
          notice.title ? h('strong', {}, notice.title) : undefined,
          notice.message,
        );
        notices.append(node);
        setTimeout(() => node.remove(), NOTICE_MS);
      }
    },
    clear() {
      show(undefined);
      notices.replaceChildren();
    },
    contains: node => backdrop.contains(node),
  };
};
