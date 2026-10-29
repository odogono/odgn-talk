import { describe, expect, test } from 'bun:test';
import { EditorState } from '@codemirror/state';
import {
  breakpointGutter,
  breakpointLines,
  markVerified,
  toggleBreakpoint,
} from '../src/breakpoints';

const state = () =>
  EditorState.create({
    doc: 'one\ntwo\nthree',
    extensions: breakpointGutter(() => {}),
  });

describe('breakpoints', () => {
  test('a toggle adds a line, and a second toggle removes it', () => {
    let s = state();
    const at = s.doc.line(2).from;
    s = s.update({ effects: toggleBreakpoint.of(at) }).state;
    expect(breakpointLines(s)).toEqual([2]);
    s = s.update({ effects: toggleBreakpoint.of(at) }).state;
    expect(breakpointLines(s)).toEqual([]);
  });

  test('breakpoints follow their lines through edits and verification', () => {
    let s = state();
    s = s.update({ effects: toggleBreakpoint.of(s.doc.line(3).from) }).state;
    s = s.update({ changes: { from: 0, insert: 'zero\n' } }).state;
    expect(breakpointLines(s)).toEqual([4]);
    s = s.update({ effects: markVerified([4]) }).state;
    expect(breakpointLines(s)).toEqual([4]);
  });
});
