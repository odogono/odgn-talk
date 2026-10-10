// How the TS REPL shows a `user` prompt and reads its answer from a typed
// line. Both are outside parity (chapter 12, Prompts): the Transcript records
// only the answer.
import { bool, list, nothing, text, type Value } from '@odgn/northtalk';
import type { UserPrompt } from '@odgn/northtalk/session';

/** The lines that ask the question. */
export const promptLines = (p: UserPrompt): string[] => {
  switch (p.k) {
    case 'confirm':
      return [`? ${p.message} [y/N]`];
    case 'enter':
      return [
        `? ${p.message}${p.fallback ? ` [${p.fallback}]` : ''}`,
        p.fallback
          ? '  an empty line gives the default'
          : '  an empty line cancels',
      ];
    case 'choose':
      return [
        `? ${p.prompt || (p.multiple ? 'Choose any' : 'Choose one')}`,
        ...p.items.map((item, i) => `  ${i + 1}. ${item}`),
        p.multiple
          ? '  numbers separated by commas, "none" for none, or an empty line to cancel'
          : '  a number, or an empty line to cancel',
      ];
  }
};

/**
 * The answer a typed line gives, or undefined when it answers nothing and the
 * question is asked again. `confirm` takes y or yes as true and anything else
 * as false; `enter` takes an empty line as the default, or else as a cancel.
 */
export const promptAnswer = (
  p: UserPrompt,
  line: string,
): Value | undefined => {
  const typed = line.trim();
  switch (p.k) {
    case 'confirm':
      return bool(/^y(es)?$/iu.test(typed));
    case 'enter':
      return line !== '' ? text(line) : p.fallback ? text(p.fallback) : nothing;
    case 'choose': {
      if (typed === '') {
        return nothing;
      }
      if (p.multiple && /^none$/iu.test(typed)) {
        return list();
      }
      const picked = typed.split(/[\s,]+/u).map(Number);
      if (
        picked.some(n => !Number.isInteger(n) || n < 1 || n > p.items.length) ||
        (!p.multiple && picked.length !== 1)
      ) {
        return undefined;
      }
      const chosen = [...new Set(picked)]
        .sort((a, b) => a - b)
        .map(n => text(p.items[n - 1]!));
      return p.multiple ? list(...chosen) : chosen[0];
    }
  }
};
