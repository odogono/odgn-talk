import { describe, expect, test } from 'bun:test';
import type { FuelRow } from '../src/fuel';
import { runLine, type LineEngine } from '../src/message-line';

/** An engine that records what it was asked to run. */
const recording = (fuel: 'measures' | 'refuses', async = false) => {
  const asked: string[] = [];
  const answer = <T>(value: T) => (async ? Promise.resolve(value) : value);
  const row = { fuel: 12 } as unknown as FuelRow;
  const base = {
    inspect: (expression: string) => {
      asked.push(`inspect ${expression}`);
      return answer({ text: 'inspected' });
    },
    command: (text: string) => {
      asked.push(`command ${text}`);
      return answer({ text: 'ran' });
    },
  };
  const engine: LineEngine =
    fuel === 'measures'
      ? {
          ...base,
          fuel: (command: string) => {
            asked.push(`fuel ${command}`);
            return answer({ reply: { text: 'ran' }, row });
          },
        }
      : { ...base, fuelRefusal: 'No Fuel here.' };
  return { asked, engine };
};

describe('runLine', () => {
  test('an ordinary line is a command', () => {
    const { asked, engine } = recording('measures');
    expect(runLine('go', engine)).toEqual({ text: 'ran' });
    expect(asked).toEqual(['command go']);
  });

  test(':inspect evaluates its expression, and needs one', () => {
    const { asked, engine } = recording('refuses');
    expect(runLine(':inspect the n of me', engine)).toEqual({
      text: 'inspected',
    });
    expect(runLine(':inspect', engine)).toEqual({
      error: 'Usage: :inspect <expression>',
    });
    expect(asked).toEqual(['inspect the n of me']);
  });

  test(':fuel measures its command and adds the Fuel line', () => {
    const { asked, engine } = recording('measures');
    const reply = runLine(':fuel go', engine) as { text: string };
    expect(reply.text.split('\n')[0]).toBe('ran');
    expect(reply.text.split('\n')).toHaveLength(2);
    expect(runLine(':fuel', engine)).toEqual({
      error: 'Usage: :fuel <command>',
    });
    expect(asked).toEqual(['fuel go']);
  });

  test('an engine that can’t measure refuses :fuel, even without a command', () => {
    const { asked, engine } = recording('refuses');
    for (const line of [':fuel go', ':fuel']) {
      expect(runLine(line, engine)).toEqual({ error: 'No Fuel here.' });
    }
    expect(asked).toEqual([]);
  });

  test('a synchronous engine answers synchronously, an async one later', async () => {
    expect(runLine('go', recording('measures').engine)).not.toBeInstanceOf(
      Promise,
    );
    const later = runLine(':fuel go', recording('measures', true).engine);
    expect(later).toBeInstanceOf(Promise);
    expect(((await later) as { text: string }).text).toStartWith('ran\n');
  });
});
