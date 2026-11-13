// Literal Editors (ADR 0175, #2180): an Add-on's other view of one kind of
// source literal, in its own window pinned to one literal. The text stays the
// only source of truth: the window follows its literal as the source changes
// and edits it only by rewriting characters of its text.
import { parseSource } from '@northtalk/ts';
import type { LiteralEditorModule } from './add-ons/api';
import {
  parseMiniNotation,
  type MiniNotationError,
  type Pattern,
} from './mini-notation';
import { patternTexts, type PatternText } from './pattern-checks';

/** The kinds of source literal a Literal Editor can be for. */
export type LiteralKind = 'mini-notation';

/** A Literal Editor an Add-on provides, by its Add-on's id. */
export type RegisteredLiteralEditor = LiteralEditorModule & {
  addOn: string;
  /** `<Add-on id>#<name>`. */
  id: string;
};

const registry = new Map<string, RegisteredLiteralEditor>();

/** Registers an Add-on's Literal Editor; a problem when its id is taken. */
export const registerLiteralEditor = (
  addOn: string,
  name: string,
  module: LiteralEditorModule,
): string | undefined => {
  const id = `${addOn}#${name}`;
  const known = registry.get(id);
  if (known && known.open !== module.open) {
    return `another Literal Editor is already ${id}`;
  }
  registry.set(id, { ...module, addOn, id });
  return undefined;
};

/** The Literal Editors for `literal` among the Add-ons a Project lists. */
export const literalEditorsFor = (
  addOns: readonly { id: string }[] | undefined,
  literal: LiteralKind,
): RegisteredLiteralEditor[] => {
  const listed = new Set((addOns ?? []).map(ref => ref.id));
  return [...registry.values()].filter(
    editor => editor.literal === literal && listed.has(editor.addOn),
  );
};

/** Where a pinned literal's text starts in its source. */
export type LiteralPin = { at: number };

/** What a Literal Editor window shows for its literal now. */
export type LiteralState =
  | { kind: 'ready'; pattern: Pattern; text: string }
  /** The literal is there, and its Mini-Notation has an error. */
  | { error: MiniNotationError; kind: 'invalid'; text: string }
  /** The source has a syntax error, so its literals can't be found. */
  | { kind: 'unreadable' }
  | { kind: 'removed' };

/** How `before` and `after` agree at their start and end. */
const ends = (before: string, after: string) => {
  let prefix = 0;
  const shortest = Math.min(before.length, after.length);
  while (prefix < shortest && before[prefix] === after[prefix]) {
    prefix++;
  }
  let suffix = 0;
  while (
    suffix < shortest - prefix &&
    before[before.length - 1 - suffix] === after[after.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { prefix, suffix };
};

/** Where `offset` in `before` is in `after`, around the one changed span. */
export const mapOffset = (
  before: string,
  after: string,
  offset: number,
): number => {
  const { prefix, suffix } = ends(before, after);
  if (offset <= prefix) {
    return offset;
  }
  return offset >= before.length - suffix
    ? offset + after.length - before.length
    : prefix;
};

const covering = (texts: PatternText[], at: number) =>
  texts.find(found => found.offset === at) ??
  texts.find(
    found => at >= found.offset && at <= found.range(0, found.text.length).to,
  );

/** The literal `at` starts or falls in, if `source` has one there. */
export const literalAt = (
  source: string,
  at: number,
): PatternText | undefined => covering(patternTexts(source), at);

/** Whether `source` parses, so a missing literal really is gone. */
const parses = (source: string): boolean => {
  try {
    return !parseSource(source).error;
  } catch {
    return false;
  }
};

/**
 * Follows a pinned literal from `before` to `after`: its new pin and what
 * its window shows.
 */
export const followLiteral = (
  pin: LiteralPin,
  before: string,
  after: string,
): { pin: LiteralPin; state: LiteralState } => {
  const texts = patternTexts(after);
  const at = mapOffset(before, after, pin.at);
  const survivor = moved(texts, before, after, pin);
  if (survivor === null) {
    return { pin: { at }, state: { kind: 'removed' } };
  }
  const found =
    survivor ?? covering(texts, at) ?? counterpart(texts, before, pin, at);
  if (!found) {
    return {
      pin: { at },
      state: parses(after) ? { kind: 'removed' } : { kind: 'unreadable' },
    };
  }
  return { pin: { at: found.offset }, state: stateOf(found.text) };
};

const touches = (found: PatternText, from: number, to: number) =>
  from <= found.range(0, found.text.length).to && to >= found.offset;

/**
 * When a change added or removed literals, what became of the pinned one if
 * the change touched it: the literal it is now, `null` when it went, or
 * `undefined` when the change left it alone. A position inside the changed
 * span says nothing about which literal that is, as deleting `loop "c4"`
 * before `loop "e4"` leaves `"e4"` where `"c4"` started, and undoing it puts
 * `"c4"` back where `"e4"` started, so the literals the change touched are
 * matched by text instead; a pin whose text the change kept fewer copies of
 * than it touched cannot be told apart from its twins, and counts as gone.
 */
const moved = (
  texts: PatternText[],
  before: string,
  after: string,
  pin: LiteralPin,
): PatternText | null | undefined => {
  const old = patternTexts(before);
  const pinned = old.find(found => found.offset === pin.at);
  if (!pinned || texts.length === old.length || !parses(after)) {
    return undefined;
  }
  const { prefix, suffix } = ends(before, after);
  const was = old.filter(found =>
    touches(found, prefix, before.length - suffix),
  );
  if (!was.includes(pinned)) {
    return undefined;
  }
  const is = texts.filter(found =>
    touches(found, prefix, after.length - suffix),
  );
  const twins = was.filter(found => found.text === pinned.text);
  const kept = is.filter(found => found.text === pinned.text);
  return kept.length < twins.length ? null : kept[twins.indexOf(pinned)]!;
};

/**
 * The literal that was pinned, when a change spanning it, such as a whole
 * replacement, moved it: the one in its place when the source still has as
 * many literals, else the nearest with its old text.
 */
const counterpart = (
  texts: PatternText[],
  before: string,
  pin: LiteralPin,
  at: number,
): PatternText | undefined => {
  const old = patternTexts(before);
  const index = old.findIndex(found => found.offset === pin.at);
  if (index < 0) {
    return undefined;
  }
  if (old.length === texts.length) {
    return texts[index];
  }
  return texts
    .filter(found => found.text === old[index]!.text)
    .sort((a, b) => Math.abs(a.offset - at) - Math.abs(b.offset - at))[0];
};

/** What a window shows for a literal with `text`. */
export const stateOf = (text: string): LiteralState => {
  const parsed = parseMiniNotation(text);
  return parsed.ok
    ? { kind: 'ready', pattern: parsed.pattern, text }
    : { kind: 'invalid', error: parsed.error, text };
};

// Characters an edit may not write, since a literal would need them escaped
// or a backtick text would read them as a hole.
const UNWRITABLE = /["`\\{}\n\r]/u;

/**
 * `source` with the pinned literal's characters `from`–`to` replaced by
 * `insert`, or why not.
 */
export const replaceInLiteral = (
  source: string,
  pin: LiteralPin,
  from: number,
  to: number,
  insert: string,
): { source: string } | { problem: string } => {
  const found = literalAt(source, pin.at);
  if (!found || found.offset !== pin.at) {
    return { problem: 'the literal is not there' };
  }
  if (from < 0 || to < from || to > found.text.length) {
    return { problem: `${from}–${to} is outside the literal` };
  }
  if (UNWRITABLE.test(insert)) {
    return {
      problem:
        'an edit cannot write quotes, braces, backslashes or line breaks',
    };
  }
  const range = found.range(from, to);
  return {
    source: source.slice(0, range.from) + insert + source.slice(range.to),
  };
};
