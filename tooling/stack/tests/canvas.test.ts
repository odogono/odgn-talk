import { expect, test } from 'bun:test';
import {
  SessionHost,
  replayTranscript,
  writeTranscript,
} from '@odgn/northtalk/session';
import { canvasCapabilities, canvasCommands } from '../src/canvas';

test('typed drawing replays headlessly with identical commands and trace', () => {
  const items: Parameters<typeof writeTranscript>[0][number][] = [];
  const trace: string[] = [];
  const host = new SessionHost({
    now: () => 0n,
    capabilities: canvasCapabilities,
    record: item => items.push(item),
    trace: line => trace.push(line),
  });
  expect(host.input(':grant art canvas')).toEqual([]);
  expect(host.input('ask art to fill "#123456"')).toEqual([]);
  expect(host.input('ask art to rectangle 1, 2, 30, 40')).toEqual([]);
  const replayTrace: string[] = [];
  const replayed = replayTranscript(items, {
    capabilities: canvasCapabilities,
    trace: line => replayTrace.push(line),
  });
  expect(writeTranscript(replayed.items)).toBe(writeTranscript(items));
  expect(replayTrace).toEqual(trace);
  expect(canvasCommands(trace, ['art']).map(c => c.op)).toEqual([
    'fill',
    'rectangle',
  ]);
});

test('a tell block draws as its one-line calls do', () => {
  const draw = (...entries: string[]) => {
    const trace: string[] = [];
    const host = new SessionHost({
      now: () => 0n,
      capabilities: canvasCapabilities,
      trace: line => trace.push(line),
    });
    host.input(':grant canvas canvas');
    for (const entry of entries) {
      expect(host.input(entry)).toEqual([]);
    }
    return canvasCommands(trace, ['canvas']);
  };
  const block = draw(
    'tell canvas\n  fill "#123456"\n  rectangle 1, 2, 30, 40\nend tell',
  );
  expect(block.map(c => c.op)).toEqual(['fill', 'rectangle']);
  expect(block).toEqual(
    draw(
      'ask canvas to fill "#123456"',
      'ask canvas to rectangle 1, 2, 30, 40',
    ),
  );
});

test('invalid drawing is rejected and omitted from rendered commands', () => {
  const trace: string[] = [];
  const host = new SessionHost({
    now: () => 0n,
    capabilities: canvasCapabilities,
    trace: line => trace.push(line),
  });
  host.input(':grant canvas canvas');
  expect(host.input('ask canvas to size 0, 400').join(' ')).toContain(
    'invalid canvas argument',
  );
  expect(host.input('ask canvas to fill "red"').join(' ')).toContain(
    'invalid canvas argument',
  );
  expect(canvasCommands(trace, ['canvas'])).toEqual([]);
});

test('every drawing operation survives Trace replay and reverse navigation', async () => {
  const { sessionSetup } = await import('@odgn/northtalk/replay');
  const { ReplayDebugger } = await import('../src/debug');
  const trace: string[] = [];
  const host = new SessionHost({
    now: () => 0n,
    capabilities: canvasCapabilities,
    trace: line => trace.push(line),
  });
  host.input(':grant canvas canvas');
  const operations = [
    'size 320, 240',
    'background "#11223344"',
    'fill "#abcdef"',
    'noFill',
    'stroke "#000000"',
    'noStroke',
    'strokeWidth 0',
    'line 1, 2, 3, 4',
    'rectangle 1, 2, 3, 4',
    'ellipse 1, 2, 3, 4',
    'textSize 18',
    'text "Hello 😀", 10, 20',
    'clear',
  ];
  for (const op of operations) {
    expect(host.input(`ask canvas to ${op}`)).toEqual([]);
  }
  const debug = new ReplayDebugger(sessionSetup(host), trace);
  expect(debug.resume().state).toBe('ended');
  expect(canvasCommands(debug.trace, ['canvas'])).toEqual(
    canvasCommands(trace, ['canvas']),
  );
  debug.runToHostInput(0);
  expect(canvasCommands(debug.trace, ['canvas'])).toEqual([]);
  debug.resume();
  expect(canvasCommands(debug.trace, ['canvas'])).toHaveLength(
    operations.length,
  );
});

test('bounds graphics resources and validates shape arguments', () => {
  const host = new SessionHost({
    now: () => 0n,
    capabilities: canvasCapabilities,
  });
  host.input(':grant canvas canvas');
  for (const op of [
    'size 4097, 1',
    'size 1.5, 2',
    'rectangle 0, 0, -1, 2',
    'ellipse 0, 0, 2, 0',
    'strokeWidth -1',
    'textSize 0',
    'line 1000001, 0, 0, 0',
  ]) {
    expect(host.input(`ask canvas to ${op}`).join(' ')).toContain(
      'invalid canvas argument',
    );
  }
  expect(host.input('ask canvas to size "wrong", 2').join(' ')).toContain('!');
  host.input(
    'on exhaust\n repeat 10001 times\n ask canvas to clear\n end repeat\nend exhaust',
  );
  expect(host.input('exhaust').join(' ')).toContain('canvas limit');
});

test('untrusted pasted Trace calls cannot bypass graphics bounds', () => {
  expect(() =>
    canvasCommands(
      ['call c1 op=canvas.size args=[999999, 999999] result=nothing'],
      ['canvas'],
    ),
  ).toThrow('Canvas dimensions');
});
