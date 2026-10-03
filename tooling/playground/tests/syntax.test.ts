import { expect, test } from 'bun:test';
import { inspectSyntax, enclosingNode } from '../src/syntax';

test('readable syntax retains errors and exact UTF-16 selection spans', () => {
  const source =
    'on greet\n  say "😀"\nend greet\non broken\n say 1 +\nend broken';
  const tree = inspectSyntax(source);
  const nodes = (n: typeof tree): (typeof tree)[] => [
    n,
    ...n.children.flatMap(nodes),
  ];
  expect(nodes(tree).some(n => n.label.startsWith('Error'))).toBe(true);
  const at = source.indexOf('"😀"');
  const selected = enclosingNode(tree, at, at + 4)!;
  expect(source.slice(selected.from, selected.to)).toContain('"😀"');
  expect(nodes(tree).some(n => n.label.startsWith('Handler'))).toBe(true);
});
