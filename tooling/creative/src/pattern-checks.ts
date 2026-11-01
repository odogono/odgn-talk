// Load-time and editor checks for the Mini-Notation a Script writes (ADR
// 0159, #1893). A pattern text is a string literal given to `play` or `loop`,
// as a Host Command or told to `sound`. Texts built at run time are checked
// when they play.
import { parseSource } from '@northtalk/ts';
import { rangeAt, type LspDiagnostic } from '@northtalk/tooling/lsp';
import { parseMiniNotation } from './mini-notation';
import type { DeepReadonly } from './readonly';
import type { Project } from './model';
import { isSoundAsset } from './sounds';

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

/** Every pattern text written as a literal in a Script. */
export const patternTexts = (
  source: string,
): { offset: number; text: string }[] => {
  let tree: Node | null;
  try {
    const parsed = parseSource(source);
    tree = parsed.error ? null : (parsed.tree as unknown as Node | null);
  } catch {
    return [];
  }
  const found: { offset: number; text: string }[] = [];
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
      const text = literal(
        source,
        first(first(node, 'ExpressionList'), 'Expression'),
      );
      if (text) {
        found.push(text);
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
  patternTexts(source).flatMap(({ text, offset }) => {
    // A Project sound's own name plays the whole sound, spaces and all.
    if (names.sounds.has(text)) {
      return [];
    }
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
    return parsed.pattern
      .words()
      .filter(word => !names.sounds.has(word.value.name))
      .map(word =>
        at(
          word.from,
          word.from + word.value.name.length,
          `No sound or sample is named “${word.value.name}”.`,
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
