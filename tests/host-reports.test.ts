import { describe, expect, test } from 'bun:test';
import {
  defineCapability,
  newGroup,
  dec,
  quantity,
  parseInstant,
  ScriptError,
  shape,
  text,
  type Call,
  type Report,
} from '../src/index';

const now = parseInstant('2026-09-30T09:00:00Z');
const later = (seconds: number) => now + BigInt(seconds) * 1_000_000_000n;
const failures = (reports: Report[]) =>
  reports.filter(r => r.kind === 'call failed');
const kinds = (reports: Report[]) => reports.map(r => r.kind);

describe('call failed reports', () => {
  test('a throwing immediate Operation reports its Host detail, before the Run ends', () => {
    const db = defineCapability('db', {
      get: {
        mode: 'immediate',
        cost: { fuel: 1 },
        do: () => {
          throw new Error('connection refused');
        },
      },
    });
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    g.load({
      name: 's',
      source:
        'on go\n  try\n    ask store to get\n  catch {code: c}\n    return c\n  end try\nend go',
      grants: { store: db.grant('all', undefined) },
    }).deliver({ name: 'go' });
    const { reports } = g.pump(now);
    expect(kinds(reports)).toEqual(['call failed', 'run end']);
    const [failed] = failures(reports);
    expect(failed).toMatchObject({
      kind: 'call failed',
      script: 's',
      operation: { capability: 'db', operation: 'get' },
    });
    expect(failed!.kind === 'call failed' && failed!.detail).toContain(
      'connection refused',
    );
    // The call id is the one the Trace's `call-failed` record names.
    const id = failed!.kind === 'call failed' ? failed!.call : '';
    expect(lines).toContain(`call-failed ${id} op=store.get`);
    // The Script sees only `host error`, with no Host detail.
    expect(reports[1]).toMatchObject({ kind: 'run end', outcome: 'completed' });
    expect(
      reports[1]!.kind === 'run end' && reports[1]!.result?.toString(),
    ).toBe('"host error"');
  });

  test('a result that breaks its Shape is reported as the Host fault it is', () => {
    const db = defineCapability('db', {
      count: {
        mode: 'immediate',
        cost: { fuel: 1 },
        result: shape.number,
        do: () => text('many'),
      },
    });
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask db to count\nend go',
      grants: { db: db.grant('all', undefined) },
    }).deliver({ name: 'go' });
    const { reports } = g.pump(now);
    expect(kinds(reports)).toEqual(['call failed', 'run end']);
    expect(failures(reports)[0]).toMatchObject({
      script: 's',
      operation: { capability: 'db', operation: 'count' },
    });
    expect(reports[1]).toMatchObject({ outcome: 'errored' });
  });

  test("a suspending call's undeclared failure is reported by the Pump that resumes it", () => {
    let pending: Call<unknown> | undefined;
    const http = defineCapability('http', {
      fetch: {
        mode: 'suspending',
        cost: { fuel: 1 },
        errors: [{ code: 'not found' }],
        start: call => {
          pending = call;
        },
      },
    });
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask web to fetch and wait\nend go',
      grants: { web: http.grant('all', undefined) },
    }).deliver({ name: 'go' });
    expect(failures(g.pump(now).reports)).toEqual([]);
    pending!.fail(new ScriptError('teapot', 'short and stout'));
    const { reports } = g.pump(now);
    expect(kinds(reports)).toEqual(['call failed', 'run end']);
    const [failed] = failures(reports);
    expect(failed).toMatchObject({
      call: pending!.id,
      operation: { capability: 'http', operation: 'fetch' },
    });
    expect(failed!.kind === 'call failed' && failed!.detail).toContain(
      'teapot',
    );
  });

  test('a declared failure is an ordinary Error, with no report', () => {
    const db = defineCapability('db', {
      get: {
        mode: 'immediate',
        cost: { fuel: 1 },
        errors: [{ code: 'not found' }],
        do: () => {
          throw new ScriptError('not found', 'no such row');
        },
      },
    });
    const g = newGroup({ name: 'g' });
    g.load({
      name: 's',
      source: 'on go\n  ask db to get\nend go',
      grants: { db: db.grant('all', undefined) },
    }).deliver({ name: 'go' });
    expect(kinds(g.pump(now).reports)).toEqual(['run end']);
  });
});

describe('the next deadline', () => {
  test('a Pump gives the earliest deadline the next Pump could fire, as its `pumped` record does', () => {
    const lines: string[] = [];
    const g = newGroup({ name: 'g', trace: line => lines.push(line) });
    const s = g.load({
      name: 's',
      source: 'on go n\n  wait n\nend go',
    });
    expect(g.pump(now).nextDeadline).toBeUndefined();
    s.deliver({ name: 'go', args: [quantity(dec('30'), 's')] });
    s.deliver({ name: 'go', args: [quantity(dec('5'), 's')] });
    expect(g.pump(now).nextDeadline).toBe(later(5));
    expect(lines.at(-1)).toEndWith(' next=2026-09-30T09:00:05Z');
    expect(g.pump(later(5)).nextDeadline).toBe(later(30));
    expect(g.pump(later(30)).nextDeadline).toBeUndefined();
  });
});
