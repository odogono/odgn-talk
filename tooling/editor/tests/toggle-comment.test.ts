import { expect, test } from 'bun:test';
import { toggleComment } from '@codemirror/commands';
import { EditorSelection, EditorState } from '@codemirror/state';
import { northtalk } from '../src/language';

const toggle = (doc: string): string => {
  let state = EditorState.create({
    doc,
    selection: EditorSelection.range(0, doc.length),
    extensions: [northtalk],
  });
  toggleComment({ state, dispatch: tr => (state = tr.state) });
  return state.doc.toString();
};

test('Mod-/ toggles -- comments on the selected lines', () => {
  const doc = 'put 1 into x\nput 2 into y';
  const commented = toggle(doc);
  expect(commented).toBe('-- put 1 into x\n-- put 2 into y');
  expect(toggle(commented)).toBe(doc);
});
