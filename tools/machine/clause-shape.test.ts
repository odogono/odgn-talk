// Reference checks for Clause Shapes (ADR 0171, #2135): a Shape after a Handler
// parameter lowers as `<param> is a S and …` in front of the Guard, so the
// clause's code, and its Fuel, are the written Guard's.
import { expect, test } from 'bun:test';
import { compileSource } from './compile';

const SHAPES =
  'shape Invoice is {amount: number}\nshape Place is {x: number}\n';

const ops = (src: string, name: string) => {
  const unit = compileSource('s', 'script', SHAPES + src, {});
  const b = unit.bodies.find(b => b.name === name)!;
  return unit.code.slice(b.start, b.end).map(i => [i.op, ...i.args].join(' '));
};

test('a Clause Shape lowers as its Guard', () => {
  expect(
    ops(
      'on h inv is an Invoice where inv is empty\n  return inv\nend h\n',
      'h',
    ),
  ).toEqual(
    ops(
      'on h inv where inv is an Invoice and inv is empty\n  return inv\nend h\n',
      'h',
    ),
  );
});

test('Shapes test left to right before the Guard, and keep the Selector', () => {
  expect(
    ops(
      'on move i is an Invoice to p is a Place where p is empty\n  return p\nend move\n',
      'move:to:',
    ),
  ).toEqual(
    ops(
      'on move i to p where i is an Invoice and p is a Place and p is empty\n  return p\nend move\n',
      'move:to:',
    ),
  );
});

test('a Shape after a pattern tests the whole argument, after the pattern', () => {
  const code = ops(
    'on h {amount: a} is an Invoice where a > 1\n  return a\nend h\n',
    'h',
  );
  const conforms = code.indexOf('call-builtin conforms 2');
  expect(code[conforms - 2]).toBe('load 1');
  expect(code.findIndex(c => c.startsWith('map-get'))).toBeLessThan(conforms);
});

test('a kind after is a, and a Fallback Handler', () => {
  expect(ops('on h n is a number\n  return n\nend h\n', 'h')).toEqual(
    ops('on h n where n is a number\n  return n\nend h\n', 'h'),
  );
  expect(
    ops(
      'on any message m is an Invoice\n  return m\nend any message\n',
      'any message',
    ),
  ).toEqual(
    ops(
      'on any message m where m is an Invoice\n  return m\nend any message\n',
      'any message',
    ),
  );
});
