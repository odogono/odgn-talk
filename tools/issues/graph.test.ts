import { expect, test } from 'bun:test';
import { type Issue, quiet, relations, renderGraph } from './graph';

const issue = (number: number, fields: Partial<Issue> = {}): Issue => ({
  assignees: [],
  blockedBy: [],
  body: '',
  labels: [],
  number,
  state: 'OPEN',
  subIssues: [],
  title: `Issue ${number}`,
  ...fields,
});

const byNumber = (...issues: Issue[]) =>
  new Map(issues.map(i => [i.number, i]));

test('reads GitHub sub-issues and dependencies', () => {
  const r = relations(
    byNumber(
      issue(1, { subIssues: [2] }),
      issue(2, { blockedBy: [3] }),
      issue(3, { parent: 1 }),
    ),
  );
  expect(r.parentOf).toEqual(
    new Map([
      [2, 1],
      [3, 1],
    ]),
  );
  expect(r.blockers.get(2)).toEqual(new Set([3]));
  expect(r.textOnly.size).toBe(0);
});

test('reads the text fallbacks in issue bodies', () => {
  const r = relations(
    byNumber(
      issue(1, { body: 'Part of #9.\nBlocked by: #2, #3.' }),
      issue(2, { body: '**Blocked by:** #3' }),
      issue(3, { body: 'Blocks #4.' }),
      issue(4),
      issue(5, { body: '- [ ] #6 and #7 are blocked by #4.' }),
      issue(6),
      issue(7, { body: 'Found while triaging #1, part of #9.' }),
      issue(9),
    ),
  );
  expect(r.parentOf).toEqual(new Map([[1, 9]]));
  expect(r.blockers.get(1)).toEqual(new Set([2, 3]));
  expect(r.blockers.get(2)).toEqual(new Set([3]));
  expect(r.blockers.get(4)).toEqual(new Set([3]));
  expect(r.blockers.get(6)).toEqual(new Set([4]));
  expect(r.blockers.get(7)).toEqual(new Set([4]));
  expect(r.textOnly.has('3>4')).toBe(true);
});

test('prefers GitHub relations over text, and ignores unknown issues', () => {
  const r = relations(
    byNumber(
      issue(1, { blockedBy: [2], body: 'Part of #3.\nBlocked by: #2, #99' }),
      issue(2),
      issue(3),
      issue(4, { subIssues: [1] }),
    ),
  );
  expect(r.parentOf.get(1)).toBe(4);
  expect(r.blockers.get(1)).toEqual(new Set([2]));
  expect(r.textOnly.size).toBe(0);
});

test('draws open issues inside their open parents, coloured by blockers', () => {
  const body = renderGraph(
    byNumber(
      issue(1, { subIssues: [2, 3, 4], title: 'Map "one"' }),
      issue(2, { blockedBy: [5] }),
      issue(3, { assignees: ['ana'] }),
      issue(4, { state: 'CLOSED' }),
      issue(5, { body: 'Blocks #3' }),
      issue(6, { title: 'Alone, see #2 | @ana' }),
    ),
    '2026-10-18T00:00:00Z',
  );
  expect(body).toContain('Generated 2026-10-18T00:00:00Z from 5 open issues.');
  expect(body).toContain(
    '  subgraph i1["#1 Map #quot;one#quot; (1/3 done)"]\n    direction LR\n    i2["#2 Issue 2"]:::blocked\n    i3["#3 Issue 3 @ana"]:::blocked\n  end',
  );
  expect(body).toContain('  i5["#5 Issue 5"]:::ready');
  expect(body).toContain('  i5 --> i2\n  i5 -.-> i3');
  expect(body).toContain(
    '  click i2 "https://github.com/odogono/odgn-talk/issues/2" _blank',
  );
  expect(body).not.toContain('click i1 ');
  expect(body).not.toContain('i4');
  expect(body).toContain(
    '| `#6` | Alone, see `#2` ' + String.raw`\|` + ' `@ana` |  |',
  );
});

test('quiet stops GitHub linking issue numbers and people', () => {
  expect(quiet('#12 by @ana-b, C# and a@')).toBe(
    '`#12` by `@ana-b`, C# and a@',
  );
});
