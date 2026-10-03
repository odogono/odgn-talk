/** LSP 3.17 uses UTF-16 positions. The Core's scalar columns stay internal. */
export type Position = { character: number; line: number };
export type Range = { end: Position; start: Position };
export type Location = { range: Range; uri: string };
export type TextEdit = { newText: string; range: Range };
export type RpcMessage = {
  error?: { code: number; message: string };
  id?: number | string | null;
  jsonrpc?: '2.0';
  method?: string;
  params?: unknown;
  result?: unknown;
};
export type LspDiagnostic = {
  code: string;
  message: string;
  range: Range;
  severity: number;
  source: string;
};
export class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}
export const record = (value: unknown): Record<string, unknown> => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new RpcError(-32_602, 'Expected an object');
  }
  return value as Record<string, unknown>;
};
export const string = (value: unknown): string => {
  if (typeof value !== 'string') {
    throw new RpcError(-32_602, 'Expected a string');
  }
  return value;
};
export const position = (value: unknown): Position => {
  const p = record(value);
  if (
    !Number.isInteger(p.line) ||
    !Number.isInteger(p.character) ||
    Number(p.line) < 0 ||
    Number(p.character) < 0
  ) {
    throw new RpcError(-32_602, 'Invalid position');
  }
  return { line: Number(p.line), character: Number(p.character) };
};
export const range = (value: unknown): Range => {
  const r = record(value);
  return { start: position(r.start), end: position(r.end) };
};
export const starts = (source: string): number[] => {
  const out = [0];
  const endings = /\r\n|\r|\n/g;
  for (const match of source.matchAll(endings)) {
    out.push(match.index + match[0].length);
  }
  return out;
};
export const offsetAt = (source: string, p: Position): number => {
  const lines = starts(source);
  if (p.line >= lines.length) {
    return source.length;
  }
  const start = lines[p.line]!;
  const end = lines[p.line + 1] ?? source.length;
  const content = source.slice(start, end).replace(/[\n\r]+$/, '');
  return start + Math.min(p.character, content.length);
};
export const positionAt = (source: string, offset: number): Position => {
  const lines = starts(source);
  let line = 0;
  while (line + 1 < lines.length && lines[line + 1]! <= offset) {
    line++;
  }
  return { line, character: offset - lines[line]! };
};
export const rangeAt = (source: string, start: number, end = start): Range => ({
  start: positionAt(source, start),
  end: positionAt(source, end),
});
const compare = (x: Position, y: Position) =>
  x.line - y.line || x.character - y.character;
export const overlaps = (a: Range, b: Range): boolean =>
  compare(a.start, b.end) <= 0 && compare(b.start, a.end) <= 0;
