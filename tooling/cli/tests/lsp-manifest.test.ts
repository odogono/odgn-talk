import { expect, test } from 'bun:test';
import { manifestSourceEdits } from '../src/lsp-manifest';
import { offsetAt } from '../../stack/src/lsp';

test('manifest rename targets the named Library source and preserves other JSON bytes', () => {
  const source =
    '{"source":"unchanged", "libraries": [\n {"source":"constant a = 1\\n", "name":"other"},\n {"version":"1", "source":"constant \\u0061 = 1\\n", "name":"maths"}\n]}';
  const edits = manifestSourceEdits(
    source,
    new Map([
      ['maths', { before: 'constant a = 1\n', after: 'constant answer = 1\n' }],
    ]),
  );
  expect(edits).toHaveLength(1);
  const edit = edits[0]!;
  const changed =
    source.slice(0, offsetAt(source, edit.range.start)) +
    edit.newText +
    source.slice(offsetAt(source, edit.range.end));
  expect(changed).toBe(
    '{"source":"unchanged", "libraries": [\n {"source":"constant a = 1\\n", "name":"other"},\n {"version":"1", "source":"constant answer = 1\\n", "name":"maths"}\n]}',
  );
});
test('manifest rename refuses source changed since it was loaded', () => {
  expect(() =>
    manifestSourceEdits(
      '{"libraries":[{"name":"maths","source":"different"}]}',
      new Map([['maths', { before: 'old', after: 'new' }]]),
    ),
  ).toThrow('Host Manifest changed');
});
