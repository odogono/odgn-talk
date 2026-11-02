// Load-time and editor checks for the Mini-Notation a Script writes (ADR
// 0159, #1893). A pattern text is a string literal given to `play` or `loop`,
// as a Host Command or told to `sound`. Texts built at run time are checked
// when they play.
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

/** The string literal an Expression is made of, if that is all it is. */
const literal = (source: string, expression: Node | undefined) => {
  const found = expression ? tokens(expression) : [];
  const [token] = found;
  if (found.length !== 1 || token?.pos === undefined || token.v === undefined) {
    return undefined;
  }
  const raw = source.slice(token.pos, token.end);
  // Only plain quoted text maps one-to-one onto the Script's characters.
  return raw === `"${token.v}"`
    ? { text: token.v, offset: token.pos + 1 }
    : undefined;
};

/** A pattern text written as a literal, and the name `on` gives, if any. */
export type PatternText = { offset: number; on?: string; text: string };

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
  patternTexts(source).flatMap(({ text, offset, on }) => {
    // A Project sound's own name plays the whole sound, spaces and all.
    if (on === undefined && names.sounds.has(text)) {
      return [];
    }
    // A name that isn't an Instrument's is left to the call to check.
    const sampler = on === undefined ? true : names.instruments?.get(on);
    const at = (from: number, to: number, message: string) => ({
      from: offset + from,
      to: offset + to,
      line: lineAt(source, offset + from),
      message,
    });
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
