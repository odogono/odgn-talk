import { describe, expect, test } from 'bun:test';
import { newGroup, nowMicros, talk, text } from '../src/index';

const answer = async (source: string, name: string) => {
  const g = newGroup({ name: 'talk' });
  const reply = g.load({ name: 's', source }).invoke(name, text('Ada'));
  g.pump(nowMicros());
  return (await reply).asText();
};

describe('talk', () => {
  test('strips the common indentation and the edge lines', () => {
    expect(talk`
      on greet who
        return who

      end greet
    `).toBe('on greet who\n  return who\n\nend greet');
  });

  test('indented source loads and runs', async () => {
    expect(
      await answer(
        talk`
          on greet who
            return who
          end greet
        `,
        'greet',
      ),
    ).toBe('Ada');
  });

  test('NorthTalk interpolation and backticks pass through their escapes', async () => {
    const source = talk`
      on greet who
        return \`Hello, \${who}\`
      end greet
    `;
    expect(source).toContain('return `Hello, ${who}`');
    expect(await answer(source, 'greet')).toBe('Hello, Ada');
  });

  test('other NorthTalk escapes reach the lexer unchanged', () => {
    expect(talk`return \`a\nb\\\``).toBe('return `a\\nb\\\\`');
  });

  test('fenced text keeps its own margin', async () => {
    const source = talk`
      on greet who
        return \`
          Hello,
            \${who}
          \`
      end greet
    `;
    expect(await answer(source, 'greet')).toBe('Hello,\n  Ada');
  });

  test('rejects JS interpolation', () => {
    const who = 'Ada';
    expect(() => talk`return ${who}`).toThrow(TypeError);
  });

  test('mixed tab and space indentation is left alone', () => {
    const raw = '\n\ton greet\n  end greet\n';
    const strings = Object.assign([raw], { raw: [raw] });
    expect(talk(strings)).toBe('\ton greet\n  end greet');
  });
});
