// Load-time and editor checks for the Mini-Notation a Script writes (ADR
// 0159, #1893). A pattern text is a literal given to `play` or `loop`, as a
// Host Command or told to `sound`: `"…"`, raw `"""…"""` or backtick text
// without holes (#2173). Texts built at run time are checked when they play.
import { parseSource } from '@northtalk/ts';
import { rangeAt, type LspDiagnostic } from '@northtalk/tooling/lsp';
import { parseMiniNotation } from './mini-notation';
import type { DeepReadonly } from './readonly';
import type { Project } from './model';
import { scriptOwners } from './script-manifest';
import {
  isSoundAsset,
  missingSoundMessage,
  MUSIC_SOUNDS,
  soundKey,
} from './sounds';

type Node = {
  children?: readonly Node[];
  end?: number;
  kind: string;
  parts?: readonly { end: number; start: number }[];
  pos?: number;
  rule?: string;
  v?: string;
};

/** The names a pattern may play. */
export type PatternNames = {
  /**
   * Each Instrument's name, and whether it is a sampler. A pattern `on` a
   * sampler plays sounds; on any other kind it plays notes (ADR 0159).
   */
  instruments?: ReadonlyMap<string, boolean>;
  /** Project sounds and kit samples. */
  sounds: ReadonlySet<string>;
};

export type PatternProblem = {
  /** Offsets in the Script, end exclusive. */
  from: number;
  /** 1-based. */
  line: number;
  message: string;
  to: number;
};

export const projectPatternNames = (
  project: DeepReadonly<Project>,
): PatternNames => ({
  instruments: new Map(
    project.instruments.map(i => [i.name, i.kind === 'sampler']),
  ),
  sounds: new Set(project.assets.filter(isSoundAsset).map(a => a.name)),
});

const PATTERN_OPERATIONS = new Set(['play', 'loop']);

const first = (node: Node | undefined, rule: string): Node | undefined =>
  node?.children?.find(c => c.rule === rule);

const tokens = (node: Node): Node[] =>
  node.kind === 'token' ? [node] : (node.children ?? []).flatMap(tokens);

/** Characters a backtick escape stands for, by the letter after `\\`. */
const ESCAPES: Record<string, string> = {
  b: '\b',
  f: '\f',
  n: '\n',
  r: '\r',
  t: '\t',
  v: '\v',
};

/**
 * Where each character of a fenced text's value sits in the Script, and one
 * past the last: the source offset of the character, or of the escape it
 * came from. Undefined when the value doesn't line up with the source, as
 * NFC normalisation can make it.
 */
const fencedOffsets = (
  source: string,
  start: number,
  end: number,
  value: string,
  escapes: boolean,
): { ends: number[]; offsets: number[] } | undefined => {
  const body = source
    .slice(start, end)
    .replaceAll(/\r\n?/gu, m => (m.length === 2 ? ' \n' : '\n'));
  // Margin-stripped form: an opening newline, and a closer whose line holds
  // only the margin (chapter 1, "Fenced text").
  const lastBreak = body.lastIndexOf('\n');
  const stripped =
    body.startsWith('\n') &&
    lastBreak >= 0 &&
    /^[ \t]*$/u.test(body.slice(lastBreak + 1));
  const margin = stripped ? end - start - (lastBreak + 1) : 0;
  const stop = stripped ? lastBreak : body.length;
  const offsets: number[] = [];
  const ends: number[] = [];
  let i = stripped ? 1 : 0;
  let lineStart = true;
  while (i < stop) {
    if (lineStart && stripped) {
      let skipped = 0;
      while (skipped < margin && i < stop && /[ \t]/u.test(body[i]!)) {
        i++;
        skipped++;
      }
      lineStart = false;
      continue;
    }
    const char = body[i]!;
    // A CRLF reads as one LF; its padding space is skipped here.
    if (char === ' ' && body[i + 1] === '\n' && source[start + i] === '\r') {
      i++;
      continue;
    }
    if (escapes && char === '\\') {
      const escape =
        /^\\(?:\n|x[0-9A-Fa-f]{2}|u\{[0-9A-Fa-f]+\}|u[0-9A-Fa-f]{4}|[^])/u.exec(
          body.slice(i, stop),
        )?.[0];
      if (escape === undefined) {
        return undefined;
      }
      if (escape !== '\\\n') {
        const letter = escape[1]!;
        const decoded =
          letter === 'x' || letter === 'u'
            ? String.fromCodePoint(
                Number.parseInt(escape.slice(2).replaceAll(/[{}]/gu, ''), 16),
              )
            : letter === '0'
              ? '\0'
              : (ESCAPES[letter] ?? letter);
        for (const unit of decoded.split('')) {
          offsets.push(start + i);
          ends.push(start + i + escape.length);
          if (value[offsets.length - 1] !== unit) {
            return undefined;
          }
        }
      }
      i += escape.length;
      continue;
    }
    offsets.push(start + i);
    ends.push(start + i + 1);
    if (value[offsets.length - 1] !== char) {
      return undefined;
    }
    lineStart = char === '\n';
    i++;
  }
  offsets.push(start + stop);
  return offsets.length === value.length + 1 ? { offsets, ends } : undefined;
};

/**
 * The text an Expression is, when it is one literal: `"…"`, raw `"""…"""`
 * or hole-free backtick text, which the language treats as literals too.
 */
const literal = (
  source: string,
  expression: Node | undefined,
): Omit<PatternText, 'on'> | undefined => {
  const found = expression ? tokens(expression) : [];
  const [token] = found;
  if (found.length !== 1 || token?.pos === undefined || token.v === undefined) {
    return undefined;
  }
  const raw = source.slice(token.pos, token.end);
  if (raw === `"${token.v}"`) {
    const offset = token.pos + 1;
    return {
      text: token.v,
      offset,
      range: (from, to) => ({ from: offset + from, to: offset + to }),
    };
  }
  const part = token.parts?.length === 1 ? token.parts[0] : undefined;
  if (!part || !(raw.startsWith('`') || raw.startsWith('"""'))) {
    return undefined;
  }
  const mapped = fencedOffsets(
    source,
    part.start,
    part.end,
    token.v,
    raw.startsWith('`'),
  );
  if (!mapped) {
    return undefined;
  }
  const { offsets, ends } = mapped;
  return {
    text: token.v,
    offset: offsets[0]!,
    // A range ends where its last character does, never past a margin.
    range: (from, to) => ({
      from: offsets[from]!,
      to: to > from ? ends[to - 1]! : offsets[to]!,
    }),
  };
};

/** A pattern text written as a literal, and the name `on` gives, if any. */
export type PatternText = {
  /** Where the text's first character is in the Script. */
  offset: number;
  on?: string;
  /** Where the text's characters `from` up to `to` are in the Script. */
  range: (from: number, to: number) => { from: number; to: number };
  text: string;
};

/** The bare name an `on` label gives, as `loop "c3" on bass` does. */
const onName = (list: Node | undefined): string | undefined => {
  const children = list?.children ?? [];
  const label = children.findIndex(
    c => c.rule === 'Label' && tokens(c)[0]?.v === 'on',
  );
  const found = label < 0 ? [] : tokens(children[label + 1]!);
  return found.length === 1 && found[0]!.kind === 'token'
    ? found[0]!.v
    : undefined;
};

/** Every pattern text written as a literal in a Script. */
export const patternTexts = (source: string): PatternText[] => {
  let tree: Node | null;
  try {
    const parsed = parseSource(source);
    tree = parsed.error ? null : (parsed.tree as unknown as Node | null);
  } catch {
    return [];
  }
  const found: PatternText[] = [];
  const visit = (node: Node) => {
    const [head, second, , operation] = node.children ?? [];
    const command =
      node.rule === 'SimpleStatement' && head?.kind === 'token'
        ? head.v
        : node.rule === 'AskTell' &&
            head?.v === 'tell' &&
            tokens(second!)
              .map(t => t.v)
              .join('') === 'sound'
          ? operation?.v
          : undefined;
    if (command && PATTERN_OPERATIONS.has(command)) {
      const list = first(node, 'ExpressionList');
      const text = literal(source, first(list, 'Expression'));
      if (text) {
        const on = onName(list);
        found.push(on === undefined ? text : { ...text, on });
      }
    }
    node.children?.forEach(visit);
  };
  if (tree) {
    visit(tree);
  }
  return found;
};

const lineAt = (source: string, offset: number) =>
  source.slice(0, offset).split('\n').length;

/** Syntax errors and unknown names in a Script's pattern texts. */
export const patternProblems = (
  source: string,
  names: PatternNames,
): PatternProblem[] =>
  patternTexts(source).flatMap(({ text, range, on }) => {
    // A Project sound's own name plays the whole sound, spaces and all.
    if (on === undefined && names.sounds.has(text)) {
      return [];
    }
    // A name that isn't an Instrument's is left to the call to check.
    const sampler = on === undefined ? true : names.instruments?.get(on);
    const at = (from: number, to: number, message: string) => {
      const span = range(from, to);
      return { ...span, line: lineAt(source, span.from), message };
    };
    const parsed = parseMiniNotation(text);
    if (!parsed.ok) {
      const { from, to, message } = parsed.error;
      return [at(from, to, message)];
    }
    if (sampler === undefined) {
      return [];
    }
    return parsed.pattern
      .words()
      .filter(word =>
        sampler
          ? !names.sounds.has(soundKey(word.value))
          : word.value.note === undefined,
      )
      .map(word =>
        sampler
          ? at(word.from, word.to, missingSoundMessage(soundKey(word.value)))
          : at(
              word.from,
              word.from + word.value.name.length,
              `“${word.value.name}” is not a note ${on} can play.`,
            ),
      );
  });

/** The same problems as editor diagnostics. */
export const patternDiagnostics = (
  source: string,
  names: PatternNames,
): LspDiagnostic[] =>
  patternProblems(source, names).map(problem => ({
    code: 'mini-notation',
    message: problem.message,
    range: rangeAt(source, problem.from, problem.to),
    severity: 1,
    source: 'folio',
  }));

/**
 * Whether a Play Session of the Project needs the Instruments' audio: it has
 * Instruments, or a Script or Library may play a Sound Pattern on the
 * default sampler. A word check is enough, since starting audio for a Script
 * that never plays one only costs an idle AudioContext.
 */
export const needsInstrumentAudio = (project: DeepReadonly<Project>): boolean =>
  project.instruments.length > 0 ||
  [
    ...scriptOwners(project).map(owner => owner.script ?? ''),
    ...project.libraries.map(library => library.source),
  ].some(source => /\b(?:play|loop)\b/u.test(source));

/**
 * The Music sounds a Project's Scripts play in pattern texts written as
 * literals, such as `bd` and `bd:1`. Names built at run time are not seen.
 */
export const projectMusicSounds = (
  project: DeepReadonly<Project>,
): Set<string> => {
  const samplers = new Set(
    project.instruments.filter(i => i.kind === 'sampler').map(i => i.name),
  );
  const keys = new Set<string>();
  for (const owner of scriptOwners(project)) {
    for (const { on, text } of patternTexts(owner.script ?? '')) {
      const parsed = parseMiniNotation(text);
      if (!parsed.ok || (on !== undefined && !samplers.has(on))) {
        continue;
      }
      for (const { value } of parsed.pattern.words()) {
        if (MUSIC_SOUNDS.has(soundKey(value))) {
          keys.add(soundKey(value));
        }
      }
    }
  }
  return keys;
};

/**
 * The order to decode a Project's sounds for its samplers (#1958): `named`,
 * those its Scripts and Libraries name in literal pattern and `play`
 * texts, in the order they appear, decode before audio starts; `later`,
 * every other sound, decodes after, so a name built at run time still
 * plays once its sound has decoded.
 */
export const soundDecodeOrder = (
  project: DeepReadonly<Project>,
): { later: string[]; named: string[] } => {
  const sounds = project.assets.filter(isSoundAsset).map(a => a.name);
  const known = new Set(sounds);
  const named: string[] = [];
  const add = (name: string) => {
    if (known.has(name) && !named.includes(name)) {
      named.push(name);
    }
  };
  const sources = [
    ...scriptOwners(project).map(owner => owner.script ?? ''),
    ...project.libraries.map(library => library.source),
  ];
  for (const source of sources) {
    for (const { text } of patternTexts(source)) {
      if (known.has(text)) {
        add(text);
        continue;
      }
      const parsed = parseMiniNotation(text);
      for (const word of parsed.ok ? parsed.pattern.words() : []) {
        add(soundKey(word.value));
      }
    }
  }
  return { named, later: sounds.filter(name => !named.includes(name)) };
};
