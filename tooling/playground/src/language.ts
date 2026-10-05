import { grammar } from '@odgn/northtalk';
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
type State = { regions: Region[] };

export const northtalkParser: StreamParser<State> = {
  name: 'northtalk',
  startState: () => ({ regions: [] }),
  copyState: state => ({
    regions: state.regions.map(region => ({ ...region })),
  }),
  token(stream, state) {
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
      return KEYWORDS.has(word[0].toLowerCase()) ? 'keyword' : 'variableName';
    }
    stream.next();
    return 'operator';
  },
};
export const northtalk = StreamLanguage.define(northtalkParser);
