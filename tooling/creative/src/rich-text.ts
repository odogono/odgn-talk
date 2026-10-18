// Structured text edits and history (#751). Offsets count UTF-16 code units,
// matching browser Ranges; a paragraph separator occupies one offset.
import type { DeepReadonly } from './readonly';
import {
  alignParagraph,
  isTextAlign,
  type RichText,
  type TextAlign,
  type TextElement,
  type TextRun,
} from './model';

export type TextStyle = Omit<TextRun, 'text'>;
export const TEXT_MARKS = ['bold', 'italic', 'underline'] as const;
export type TextMark = (typeof TEXT_MARKS)[number];
export type TextSelection = { end: number; start: number };

const runsOf = (text: DeepReadonly<RichText>): TextRun[] =>
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

const slice = (
  text: DeepReadonly<RichText>,
  start: number,
  end = Infinity,
): TextRun[] => {
  let offset = 0;
  return runsOf(text).flatMap(run => {
    const from = Math.max(0, start - offset);
    const to = Math.min(run.text.length, end - offset);
    offset += run.text.length;
    return to > from ? [{ ...run, text: run.text.slice(from, to) }] : [];
  });
};

/** The index of the paragraph holding `offset`. */
const paragraphAt = (text: DeepReadonly<RichText>, offset: number): number => {
  let remaining = offset;
  for (const [i, p] of text.entries()) {
    const length = p.runs.reduce((n, r) => n + r.text.length, 0);
    if (remaining <= length) {
      return i;
    }
    remaining -= length + 1;
  }
  return text.length - 1;
};

/** Gives each paragraph, in order, its alignment from `aligns`. */
const withAligns = (
  text: RichText,
  aligns: readonly (TextAlign | undefined)[],
): RichText => {
  text.forEach((p, i) => alignParagraph(p, aligns[i]));
  return text;
};

/**
 * Replace a selection with runs. The paragraph the selection starts in keeps
 * its alignment, and `middleAligns` aligns each paragraph the runs open.
 */
const splice = (
  text: DeepReadonly<RichText>,
  selection: TextSelection,
  middle: TextRun[],
  middleAligns: (TextAlign | undefined)[],
): RichText => {
  const first = paragraphAt(text, selection.start);
  const last = paragraphAt(text, selection.end);
  return withAligns(
    normalizeRichText([
      ...slice(text, 0, selection.start),
      ...middle,
      ...slice(text, selection.end),
    ]),
    [
      ...text.slice(0, first + 1).map(p => p.align),
      ...middleAligns,
      ...text.slice(last + 1).map(p => p.align),
    ],
  );
};

/**
 * Replace a selection, preserving the surrounding text's styles. Inserted
 * paragraphs without an alignment take the one the selection starts in.
 */
export const replaceTextRange = (
  text: DeepReadonly<RichText>,
  selection: TextSelection,
  inserted: RichText,
): RichText => {
  const align = text[paragraphAt(text, selection.start)]?.align;
  return splice(
    text,
    selection,
    runsOf(inserted),
    inserted.slice(1).map(p => p.align ?? align),
  );
};

/** Apply or remove marks on a selection without changing its plain text. */
export const styleTextRange = (
  text: DeepReadonly<RichText>,
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
    text
      .slice(
        paragraphAt(text, selection.start) + 1,
        paragraphAt(text, selection.end) + 1,
      )
      .map(p => p.align),
  );

/** Align every paragraph a selection touches, the caret's when it is empty. */
export const alignTextRange = (
  text: DeepReadonly<RichText>,
  selection: TextSelection,
  align: TextAlign,
): RichText => {
  const first = paragraphAt(text, selection.start);
  const last = paragraphAt(text, selection.end);
  return text.map((p, i) => {
    const next = { ...p, runs: p.runs.map(r => ({ ...r })) };
    if (i >= first && i <= last) {
      alignParagraph(next, align);
    }
    return next;
  });
};

/** The alignment shared by every paragraph a selection touches, if any. */
export const rangeAlign = (
  text: DeepReadonly<RichText>,
  selection: TextSelection,
): TextAlign | undefined => {
  const aligns = new Set(
    text
      .slice(
        paragraphAt(text, selection.start),
        paragraphAt(text, selection.end) + 1,
      )
      .map(p => p.align ?? 'left'),
  );
  return aligns.size === 1 ? [...aligns][0] : undefined;
};

export const rangeHasStyle = (
  text: DeepReadonly<RichText>,
  selection: TextSelection,
  mark: TextMark,
): boolean => {
  const runs = slice(text, selection.start, selection.end).filter(
    r => r.text !== '\n',
  );
  return runs.length > 0 && runs.every(run => run[mark]);
};

/** Reformats rich text from any source into the form `normalizeRichText` makes. */
export const renormalizeRichText = (text: DeepReadonly<RichText>): RichText =>
  withAligns(
    normalizeRichText(runsOf(text)),
    text.map(p => (isTextAlign(p.align) ? p.align : undefined)),
  );

/**
 * One text Element's text edits, recorded in the Stack editor's history so
 * undo and redo interleave them with every other authored edit.
 */
export type TextHistory = {
  readonly canRedo: boolean;
  readonly canUndo: boolean;
  /** Looked up on each read: undo can replace the Element's object. */
  readonly element: DeepReadonly<TextElement>;
  redo(): void;
  set(text: DeepReadonly<RichText>): void;
  undo(): void;
};
