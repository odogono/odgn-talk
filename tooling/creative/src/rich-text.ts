// Structured text edits and history (#751). Offsets count UTF-16 code units,
// matching browser Ranges; a paragraph separator occupies one offset.
import { type RichText, type TextElement, type TextRun } from './model';

export type TextStyle = Omit<TextRun, 'text'>;
export const TEXT_MARKS = ['bold', 'italic', 'underline'] as const;
export type TextMark = (typeof TEXT_MARKS)[number];
export type TextSelection = { end: number; start: number };

const runsOf = (text: RichText): TextRun[] =>
  text.flatMap((p, i) => [...(i ? [{ text: '\n' }] : []), ...p.runs]);

/** Keep only supported marks, merge adjacent equal runs, and split paragraphs. */
export const normalizeRichText = (runs: readonly TextRun[]): RichText => {
  const result: RichText = [{ runs: [] }];
  for (const run of runs) {
    const style: TextStyle = {};
    for (const mark of TEXT_MARKS) {
      if (run[mark]) {
        style[mark] = true;
      }
    }
    if (run.color) {
      style.color = run.color;
    }
    run.text
      .replaceAll(/\r\n?/gu, '\n')
      .split('\n')
      .forEach((text, i) => {
        if (i) {
          result.push({ runs: [] });
        }
        const paragraph = result.at(-1)!;
        const previous = paragraph.runs.at(-1);
        if (!text) {
          return;
        }
        if (
          previous &&
          previous.color === style.color &&
          TEXT_MARKS.every(mark => previous[mark] === style[mark])
        ) {
          previous.text += text;
        } else {
          paragraph.runs.push({ ...style, text });
        }
      });
  }
  for (const p of result) {
    if (!p.runs.length) {
      p.runs.push({ text: '' });
    }
  }
  return result;
};

const slice = (text: RichText, start: number, end = Infinity): TextRun[] => {
  let offset = 0;
  return runsOf(text).flatMap(run => {
    const from = Math.max(0, start - offset);
    const to = Math.min(run.text.length, end - offset);
    offset += run.text.length;
    return to > from ? [{ ...run, text: run.text.slice(from, to) }] : [];
  });
};

const splice = (
  text: RichText,
  selection: TextSelection,
  middle: TextRun[],
): RichText =>
  normalizeRichText([
    ...slice(text, 0, selection.start),
    ...middle,
    ...slice(text, selection.end),
  ]);

/** Replace a selection, preserving the surrounding text's styles. */
export const replaceTextRange = (
  text: RichText,
  selection: TextSelection,
  inserted: RichText,
): RichText => splice(text, selection, runsOf(inserted));

/** Apply or remove marks on a selection without changing its plain text. */
export const styleTextRange = (
  text: RichText,
  selection: TextSelection,
  style: TextStyle,
): RichText =>
  splice(
    text,
    selection,
    slice(text, selection.start, selection.end).map(run => ({
      ...run,
      ...style,
    })),
  );

export const rangeHasStyle = (
  text: RichText,
  selection: TextSelection,
  mark: TextMark,
): boolean => {
  const runs = slice(text, selection.start, selection.end).filter(
    r => r.text !== '\n',
  );
  return runs.length > 0 && runs.every(run => run[mark]);
};

/** Reformats rich text from any source into the form `normalizeRichText` makes. */
export const renormalizeRichText = (text: RichText): RichText =>
  normalizeRichText(runsOf(text));

/**
 * One text Element's text edits, recorded in the Stack editor's history so
 * undo and redo interleave them with every other authored edit.
 */
export type TextHistory = {
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  /** Looked up on each read: undo can replace the Element's object. */
  readonly element: TextElement;
  redo(): void;
  set(text: RichText): void;
  undo(): void;
};
