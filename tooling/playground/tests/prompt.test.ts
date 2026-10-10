import { expect, test } from 'bun:test';
import type {
  FromSession,
  SessionRequest,
  SessionResponse,
} from '../src/protocol';

test('the worker collects, detaches, refuses and cancels documentation Entries, and queues lines while it sleeps', async () => {
  const worker = new Worker(
    new URL('../src/session.worker.ts', import.meta.url),
  );
  let id = 0;
  const call = (request: SessionRequest) =>
    new Promise<SessionResponse>((resolve, reject) => {
      const expected = ++id;
      worker.onmessage = ({ data }: MessageEvent<FromSession>) => {
        if (data.id === expected) {
          resolve(data.response);
        }
      };
      worker.onerror = reject;
      worker.postMessage({ id: expected, request });
    });
  const line = async (text: string) => {
    const result = await call({ t: 'line', text });
    if (result.t !== 'state') {
      throw new Error(`expected state, got ${result.t}`);
    }
    return result.state;
  };
  try {
    const opened = await call({ t: 'open' });
    expect(opened.t === 'state' && opened.state.setup).toEqual([
      ':grant canvas canvas',
    ]);
    expect((await line('--| abandoned')).prompt).toBe('continue');
    await call({ t: 'cancel' });
    expect(await call({ t: 'transcript' })).toEqual({
      t: 'transcript',
      text: '> :grant canvas canvas\n',
      ended: false,
    });
    for (const text of [
      '--| Docs.',
      '--|',
      'function inc n',
      ' return n + 1',
    ]) {
      expect((await line(text)).prompt).toBe('continue');
    }
    const completed = await line('end inc');
    expect(completed.prompt).toBe('entry');
    expect(completed.source).toBe(
      '--| Docs.\n--|\nfunction inc n\n return n + 1\nend inc\n',
    );
    await line('--| invalid');
    const refused = await line('inc(2)');
    expect(refused.source).toBe(completed.source);
    expect(refused.lines).toContainEqual({
      k: 'item',
      item: { k: 'output', text: '! bad arguments' },
    });
    await line('--| detached');
    expect((await line('')).prompt).toBe('continue');
    expect((await line('constant k = 2')).source).toEndWith(
      '--| detached\n\nconstant k = 2\n',
    );
    await line('--| separated');
    expect((await line('-- ordinary')).prompt).toBe('entry');
    expect((await line('script variable v = 3')).source).toEndWith(
      'script variable v = 3\n',
    );
    const transcript = await call({ t: 'transcript' });
    expect(transcript.t === 'transcript' && transcript.text).toContain(
      '> --| Docs.\n| --|\n| function inc n',
    );

    // A line typed while the session sleeps waits its turn, and runs when
    // the session wakes.
    await line('on nap\n wait 50 ms\n say "awake"\nend nap');
    expect((await line('nap and wait')).prompt).toBe('sleeping');
    const queued = await line('say "queued"');
    expect(queued.prompt).toBe('sleeping');
    expect(queued.lines).toEqual([]);
    const woke = await new Promise<FromSession>(resolve => {
      worker.onmessage = ({ data }: MessageEvent<FromSession>) => {
        if (data.id === undefined && data.response.t === 'state') {
          resolve(data);
        }
      };
    });
    if (woke.response.t !== 'state') {
      throw new Error(`expected state, got ${woke.response.t}`);
    }
    expect(woke.response.state.prompt).toBe('entry');
    expect(
      woke.response.state.lines.flatMap(l =>
        l.k === 'item' && l.item.k === 'output'
          ? [l.item.text]
          : l.k === 'item' && l.item.k === 'input'
            ? [`> ${l.item.source}`]
            : [],
      ),
    ).toEqual(['awake', '> say "queued"', 'queued']);
  } finally {
    worker.terminate();
  }
});
