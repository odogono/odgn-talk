import { expect, test } from 'bun:test';
import { callId, compareCallIds, parseCallId, senderRun } from '../src/call-id';

test('a call id reads back as its Run and number', () => {
  expect(callId('orders/r2', 1)).toBe('orders/r2.c1');
  expect(parseCallId('orders/r2.c12')).toEqual({ runId: 'orders/r2', n: 12 });
  for (const id of [
    'orders/r2',
    'orders/r2.c0',
    'orders/r2.c',
    '.c1',
    'r.c01',
  ]) {
    expect(parseCallId(id)).toBeUndefined();
  }
});

test('a sender is the Run of a call id, or a Run id as it is', () => {
  expect(senderRun('orders/r2.c3')).toBe('orders/r2');
  expect(senderRun('orders/r2')).toBe('orders/r2');
});

test('call ids sort by Script, Run number, then call number', () => {
  expect(
    ['b/r1.c1', 'a/r10.c1', 'a/r2.c10', 'a/r2.c9'].sort(compareCallIds),
  ).toEqual(['a/r2.c9', 'a/r2.c10', 'a/r10.c1', 'b/r1.c1']);
});
