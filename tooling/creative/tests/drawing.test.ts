import { expect, test } from 'bun:test';
import type { CanvasCommand } from '@northtalk/tooling/canvas';
import { Drawing, ReceivedDrawing, type DrawingMark } from '../src/drawing';

const command = (op: string, ...args: unknown[]) =>
  ({ op, args }) as CanvasCommand;
const ops = (commands: readonly CanvasCommand[]) => commands.map(c => c.op);

// Sends what changed through a structured clone, as the worker does.
const send = (
  drawing: Drawing,
  received: ReceivedDrawing,
  mark?: DrawingMark,
): DrawingMark | undefined => {
  const change = drawing.changesSince(mark);
  if (!change) {
    return mark;
  }
  received.apply(structuredClone(change));
  return change.mark;
};

test('a received Drawing follows append, reset and append', () => {
  const drawing = new Drawing([command('fill', '#ff0000')]);
  const received = new ReceivedDrawing();
  let mark = send(drawing, received);
  expect(ops(received.commands)).toEqual(['fill']);

  drawing.add(command('rect', 0, 0, 1, 1));
  const appended = received.commands;
  mark = send(drawing, received, mark);
  expect(received.commands).toBe(appended);
  expect(ops(received.commands)).toEqual(['fill', 'rect']);

  drawing.add(command('background', '#000000'));
  mark = send(drawing, received, mark);
  expect(received.commands).not.toBe(appended);
  // The style survives the reset.
  expect(ops(received.commands)).toEqual(['fill', 'background']);

  drawing.add(command('rect', 1, 1, 1, 1));
  const reset = received.commands;
  mark = send(drawing, received, mark);
  expect(received.commands).toBe(reset);
  expect(received.commands).toEqual(drawing.commands);
});

test('a Drawing reports nothing when unchanged since a mark', () => {
  const drawing = new Drawing([]);
  const mark = drawing.changesSince()!.mark;
  expect(drawing.changesSince(mark)).toBeUndefined();
});

test('a reset is reported even when the length is unchanged', () => {
  const drawing = new Drawing([]);
  drawing.add(command('background', '#000000'));
  const mark = drawing.changesSince()!.mark;
  drawing.add(command('background', '#ffffff'));
  const change = drawing.changesSince(mark)!;
  expect(change.reset).toBe(true);
  expect(change.commands[0]!.args).toEqual(['#ffffff']);
});

test('a new mark sends the whole Drawing as a reset', () => {
  const drawing = new Drawing([command('rect', 0, 0, 1, 1)]);
  drawing.add(command('rect', 1, 1, 1, 1));
  const change = drawing.changesSince()!;
  expect(change.reset).toBe(true);
  expect(ops(change.commands)).toEqual(['rect', 'rect']);
});
