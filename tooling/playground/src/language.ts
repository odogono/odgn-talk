import {
  grammar,
  parseSourceRecovering,
  parseEntry,
  type SyntaxElement,
} from '@odgn/northtalk';
import { StreamLanguage, type StreamParser } from '@codemirror/language';

const KEYWORDS = new Set([
  ...(grammar as { reserved: string[] }).reserved,
  'use',
  'from',
  'as',
  'constant',
  'script',
  'variable',
  'say',
  'with',
  'each',
  'all',
  'any',
  'ignoring',
  'case',
  'contains',
]);

type Region =
  | { kind: 'raw'; width: number }
  | { kind: 'template' }
  | { depth: number; kind: 'hole' };
type State = { labels: Set<number>; pending: string; regions: Region[] };

// Classify open label words through the Core's lossless parser, rather than
// maintaining a keyword list that would also colour argument variables.
const labelOffsets = (line: string, lineStart: number): Set<number> => {
  const prefix = /^\s*(?:on|function)\b/.test(line) ? '' : 'on highlight\n';
  const tree = parseSourceRecovering(`${prefix}${line}\nend\n`).tree;
  const labels = new Set<number>();
  const work: SyntaxElement[] = [tree];
  while (work.length) {
    const e = work.pop()!;
    if (e.kind === 'node') {
      if (e.rule === 'Label') {
        const token = e.children[0];
        if (token?.kind === 'token') {
          labels.add(token.pos - prefix.length - lineStart);
        }
      } else {
        work.push(...e.children);
      }
    }
  }
  return labels;
};

export const northtalkParser: StreamParser<State> = {
  name: 'northtalk',
  startState: () => ({ labels: new Set(), pending: '', regions: [] }),
  copyState: state => ({
    labels: new Set(state.labels),
    pending: state.pending,
    regions: state.regions.map(region => ({ ...region })),
  }),
  blankLine(state) {
    if (state.pending) {
      state.pending += '\n';
    }
  },
  token(stream, state) {
    if (stream.sol()) {
      const source = state.pending + stream.string;
      state.labels = labelOffsets(source, state.pending.length);
      const parsed = parseEntry(`${source}\n`, () => true);
      // Carry unfinished argument expressions and patterns, not whole blocks.
      // An Argument Label at a physical line ending is an error, not continuation.
      const blockEnd = /^expected `(?:end|else|catch|finally)`/.test(
        parsed.error?.message ?? '',
      );
      state.pending =
        parsed.error && parsed.incomplete && !blockEnd ? `${source}\n` : '';
    }
    const region = state.regions.at(-1);
    if (region?.kind === 'raw') {
      const quotes = stream.match(/^"{3,}/, false);
      if (
        quotes &&
        typeof quotes !== 'boolean' &&
        quotes[0].length >= region.width
      ) {
        stream.match(quotes[0]);
        if (quotes[0].length > region.width) {
          return 'invalid';
        }
        state.regions.pop();
        return 'operator';
      }
      while (!stream.eol() && !stream.match('"'.repeat(region.width), false)) {
        stream.next();
      }
      return 'string';
    }
    if (region?.kind === 'template') {
      if (stream.match('`')) {
        state.regions.pop();
        return 'operator';
      }
      if (stream.match('${')) {
        state.regions.push({ kind: 'hole', depth: 0 });
        return 'operator';
      }
      while (!stream.eol()) {
        if (stream.match('`', false) || stream.match('${', false)) {
          break;
        }
        if (stream.next() === '\\') {
          stream.next();
        }
      }
      return 'string';
    }
    if (stream.eatSpace()) {
      return null;
    }
    if (stream.match('--')) {
      stream.skipToEnd();
      return 'comment';
    }
    const raw = stream.match(/^"{3,}/);
    if (raw && typeof raw !== 'boolean') {
      state.regions.push({ kind: 'raw', width: raw[0].length });
      return 'operator';
    }
    if (stream.match('`')) {
      state.regions.push({ kind: 'template' });
      return 'operator';
    }
    if (stream.match('"')) {
      while (!stream.eol() && stream.next() !== '"') {
        // Ordinary quoted text ends on this line.
      }
      return 'string';
    }
    if (region?.kind === 'hole') {
      if (stream.match('{')) {
        region.depth++;
        return 'operator';
      }
      if (stream.match('}')) {
        if (region.depth-- === 0) {
          state.regions.pop();
        }
        return 'operator';
      }
    }
    if (stream.match(/^\d[\d_]*(\.\d+)?/u)) {
      return 'number';
    }
    const word = stream.match(/^[\p{L}_][\p{L}\p{N}_]*/u);
    if (word && typeof word !== 'boolean') {
      if (state.labels.has(stream.start)) {
        return 'labelName';
      }
      return KEYWORDS.has(word[0].toLowerCase()) ? 'keyword' : 'variableName';
    }
    stream.next();
    return 'operator';
  },
};
export const northtalk = StreamLanguage.define(northtalkParser);
