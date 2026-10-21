// Paints a Canvas Element's Drawing with Canvas 2D, in the Element's own
// coordinates: one unit is one Page pixel, clipped to the frame (ADR 0116).
// Edit and Play share it. A Drawing that only grew since the last paint
// gets just its new commands; any other change repaints from the defaults.
import {
  paintCanvasShape,
  type CanvasCommand,
} from '@northtalk/tooling/canvas';
import { readDisplay } from '@northtalk/ts';
import type { CanvasElement } from './model';
import type { DeepReadonly } from './readonly';

type Painted = {
  commands: DeepReadonly<CanvasCommand[]>;
  fill: boolean;
  length: number;
  scale: number;
  stroke: boolean;
  strokeWidth: number;
};
const painted = new WeakMap<HTMLCanvasElement, Painted>();

const paint = (
  context: CanvasRenderingContext2D,
  state: Painted,
  command: DeepReadonly<CanvasCommand>,
  width: number,
  height: number,
) => {
  // Arguments keep their display spelling; the signature fixes their kinds.
  const n = (i: number) => Number(command.args[i]);
  const t = (i: number) => readDisplay(command.args[i]!).asText()!;
  switch (command.op) {
    case 'background':
      context.save();
      context.fillStyle = t(0);
      context.clearRect(0, 0, width, height);
      context.fillRect(0, 0, width, height);
      context.restore();
      return;
    case 'fill':
      state.fill = true;
      context.fillStyle = t(0);
      return;
    case 'noFill':
      state.fill = false;
      return;
    case 'stroke':
      state.stroke = true;
      context.strokeStyle = t(0);
      return;
    case 'noStroke':
      state.stroke = false;
      return;
    case 'strokeWidth':
      state.strokeWidth = n(0);
      if (state.strokeWidth > 0) {
        context.lineWidth = state.strokeWidth;
      }
      return;
    case 'strokeCap':
      context.lineCap = t(0) as CanvasLineCap;
      return;
    case 'strokeJoin':
      context.lineJoin = t(0) as CanvasLineJoin;
      return;
    case 'textSize':
      context.font = `${n(0)}px sans-serif`;
      return;
    case 'text':
      if (state.fill) {
        context.fillText(t(0), n(1), n(2));
      }
      if (state.stroke && state.strokeWidth > 0) {
        context.strokeText(t(0), n(1), n(2));
      }
      return;
  }
  paintCanvasShape(
    context,
    command.op,
    n,
    state.fill,
    state.stroke && state.strokeWidth > 0,
  );
};

/** Brings `canvas` up to date with the Element's size and Drawing. */
export const paintCanvas = (
  canvas: HTMLCanvasElement,
  element: DeepReadonly<CanvasElement>,
): void => {
  const scale = globalThis.devicePixelRatio || 1;
  const width = Math.max(1, Math.round(element.width * scale));
  const height = Math.max(1, Math.round(element.height * scale));
  const context = canvas.getContext('2d');
  if (!context) {
    return;
  }
  let state = painted.get(canvas);
  const resized = canvas.width !== width || canvas.height !== height;
  if (
    !state ||
    resized ||
    state.scale !== scale ||
    state.commands !== element.drawing ||
    state.length > element.drawing.length
  ) {
    if (resized) {
      canvas.width = width;
      canvas.height = height;
    }
    context.setTransform(scale, 0, 0, scale, 0, 0);
    context.clearRect(0, 0, element.width, element.height);
    context.fillStyle = context.strokeStyle = '#000000';
    context.lineWidth = 1;
    context.lineCap = 'butt';
    context.lineJoin = 'miter';
    context.font = '12px sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
    state = {
      commands: element.drawing,
      length: 0,
      scale,
      fill: true,
      stroke: true,
      strokeWidth: 1,
    };
    painted.set(canvas, state);
  }
  for (let i = state.length; i < element.drawing.length; i++) {
    paint(context, state, element.drawing[i]!, element.width, element.height);
  }
  state.length = element.drawing.length;
};
