// `send-fits-no-clause` may stay quiet when unsure, but must never warn
// about an argument the Core would accept: each warning is checked against
// the Core's own `is a` (#2059).
import { expect, test } from 'bun:test';
import { createGroup } from '@northtalk/ts';
import { analyzeWorkspace } from '../src/lsp/workspace';

const shapes = [
  'text',
  'number',
  'boolean',
  'any',
  'list',
  'map',
  'quantity',
  'list of number',
  'optional text',
  'text or number',
  '{sku: text, qty: number}',
  '{sku: text, qty: optional number}',
  '{sku: text, ...}',
  '{tags: list of text}',
  'GBP',
];
const literals = [
  '"a"',
  '4',
  '2.5',
  'true',
  'nothing',
  '[]',
  '[1, 2]',
  '["a", 2]',
  '{}',
  '{sku: "a", qty: 1}',
  '{sku: "a"}',
  '{sku: "a", qty: nothing}',
  '{sku: "a", qty: 1, extra: true}',
  '{tags: ["a"]}',
  '{tags: [1]}',
];

test('a send-fits-no-clause warning means the Core rejects the argument', async () => {
  let warnings = 0;
  for (const shape of shapes) {
    for (const literal of literals) {
      const source = [
        `shape S is ${shape}`,
        'on h x is a S',
        '  return 1',
        'end h',
        'on go b',
        `  send h with ${literal} to b`,
        'end go',
        'on t',
        `  return ${literal} is a S`,
        'end t',
      ].join('\n');
      const uri = 'file:///workspace/s.talk';
      const analysis = analyzeWorkspace(
        [{ uri, text: source }],
        null,
        'standard',
      ).get(uri)!;
      const warned = analysis.lints.some(l => l.id === 'send-fits-no-clause');
      await using group = createGroup({ name: 'g' });
      const script = group.load({ name: 's', source });
      const accepted = await script.handlers.t!();
      if (warned) {
        warnings++;
        expect([shape, literal, accepted]).toEqual([shape, literal, false]);
      }
    }
  }
  // The check isn't vacuous.
  expect(warnings).toBeGreaterThan(40);
});
