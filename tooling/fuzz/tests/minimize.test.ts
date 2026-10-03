import { expect, test } from 'bun:test';
import { generate } from '../src/generator';
import { minimize } from '../src/minimize';
import { signatureKey, type Finding } from '../src/model';

const bug: Finding = {
  classification: 'semantic',
  message: 'fixture bug',
  signature: {
    oracle: 'fixture',
    record: 'run',
    field: 'value',
    owner: 'a:bump',
  },
};
test('both reduction stages remove irrelevant actions and source while preserving the first signature', async () => {
  const c = generate('1', { features: ['compute'], witness: true });
  const interesting = async (candidate: typeof c) =>
    candidate.setup.scripts?.[0]?.text?.includes('add') ? [bug] : [];
  const result = await minimize(c, bug.signature, interesting, {
    budgetMs: 1000,
  });
  expect(result.case.inputs.length).toBeLessThan(c.inputs.length);
  expect(result.case.setup.scripts![0]!.text!.length).toBeLessThan(
    c.setup.scripts![0]!.text!.length,
  );
  expect(signatureKey((await interesting(result.case))[0]!.signature)).toBe(
    signatureKey(bug.signature),
  );
  expect(result.stages).toEqual(['choices', 'concrete']);
});

test('minimization cannot jump to a different earlier finding', async () => {
  const c = generate('2', { features: ['compute'], witness: true });
  const other = { ...bug, signature: { ...bug.signature, field: 'fuel' } };
  const result = await minimize(
    c,
    bug.signature,
    async candidate =>
      candidate.inputs.length === c.inputs.length ? [bug] : [other],
    { budgetMs: 1000 },
  );
  expect(result.case.inputs.length).toBe(c.inputs.length);
});

test('budget exhaustion returns the best retained reproducer', async () => {
  const c = generate('3', { features: ['compute'], witness: true });
  const result = await minimize(c, bug.signature, async () => [bug], {
    budgetMs: 0,
  });
  expect(result.case).toEqual(c);
  expect(result.exhausted).toBe(true);
});
