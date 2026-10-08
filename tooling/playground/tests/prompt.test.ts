import { expect, test } from 'bun:test';
import type {
  FromSession,
  SessionRequest,
  SessionResponse,
} from '../src/protocol';

test('the worker collects, detaches, refuses and cancels documentation Entries', async () => {
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
    await call({ t: 'open' });
    expect((await line('--| abandoned')).prompt).toBe('continue');
    await call({ t: 'cancel' });
    expect(await call({ t: 'transcript' })).toEqual({
      t: 'transcript',
      text: '',
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
  } finally {
    worker.terminate();
  }
});
