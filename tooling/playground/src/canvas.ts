import { readDisplay, type Value } from '@northtalk/ts';
import {
  paintCanvasShape,
  type CanvasCommand,
} from '@northtalk/tooling/canvas';

const numberAt = (args: Value[], i: number) => Number(args[i]!.toString());
const textAt = (args: Value[], i: number) => args[i]!.asText()!;

/** Projects an ordered command prefix. A replay seek rebuilds from defaults. */
export const createCanvasView = (
  canvas: HTMLCanvasElement,
  label: HTMLElement,
) => {
  const context = canvas.getContext('2d')!;
  let previous: string[] = [];
  let revision = -1;
  let fill = true;
  let stroke = true;
  let strokeWidth = 1;
  // Flags saved by each open `push`; the context saves the rest.
  let saved: { fill: boolean; stroke: boolean; strokeWidth: number }[] = [];
  // `clear` and `background` keep the style but reset the transform and
  // empty the `push` stack, as in Folio (ADR 0116).
  const resetTransform = () => {
    const { fillStyle, strokeStyle, lineWidth, lineCap, lineJoin, font } =
      context;
    saved.forEach(() => context.restore());
    saved = [];
    context.setTransform(1, 0, 0, 1, 0, 0);
    Object.assign(context, {
      fillStyle,
      strokeStyle,
      lineWidth,
      lineCap,
      lineJoin,
      font,
    });
  };
  const defaults = () => {
    saved = [];
    fill = stroke = true;
    strokeWidth = 1;
    context.fillStyle = context.strokeStyle = '#000000';
    context.lineWidth = 1;
    context.lineCap = 'butt';
    context.lineJoin = 'miter';
    context.font = '12px sans-serif';
    context.textAlign = 'left';
    context.textBaseline = 'alphabetic';
  };
  const size = (width: number, height: number) => {
    canvas.width = width;
    canvas.height = height;
    defaults();
    label.textContent = `${width} × ${height}`;
  };
  size(400, 400);
  return (commands: CanvasCommand[], nextRevision: number) => {
    if (nextRevision <= revision) {
      return;
    }
    revision = nextRevision;
    const encoded = commands.map(c => JSON.stringify(c));
    if (
      previous.length > encoded.length ||
      previous.some((c, i) => c !== encoded[i])
    ) {
      size(400, 400);
      previous = [];
    }
    for (const command of commands.slice(previous.length)) {
      const args = command.args.map(a => readDisplay(a));
      switch (command.op) {
        case 'size':
          size(numberAt(args, 0), numberAt(args, 1));
          break;
        case 'clear':
          resetTransform();
          context.clearRect(0, 0, canvas.width, canvas.height);
          break;
        case 'background':
          resetTransform();
          context.save();
          context.fillStyle = textAt(args, 0);
          context.clearRect(0, 0, canvas.width, canvas.height);
          context.fillRect(0, 0, canvas.width, canvas.height);
          context.restore();
          break;
        case 'fill':
          fill = true;
          context.fillStyle = textAt(args, 0);
          break;
        case 'noFill':
          fill = false;
          break;
        case 'stroke':
          stroke = true;
          context.strokeStyle = textAt(args, 0);
          break;
        case 'noStroke':
          stroke = false;
          break;
        case 'strokeWidth':
          strokeWidth = numberAt(args, 0);
          if (strokeWidth > 0) {
            context.lineWidth = strokeWidth;
          }
          break;
        case 'strokeCap':
          context.lineCap = textAt(args, 0) as CanvasLineCap;
          break;
        case 'strokeJoin':
          context.lineJoin = textAt(args, 0) as CanvasLineJoin;
          break;
        case 'push':
          saved.push({ fill, stroke, strokeWidth });
          context.save();
          break;
        case 'pop':
          ({ fill, stroke, strokeWidth } = saved.pop() ?? {
            fill,
            stroke,
            strokeWidth,
          });
          context.restore();
          break;
        case 'translate':
          context.translate(numberAt(args, 0), numberAt(args, 1));
          break;
        case 'rotate':
          context.rotate(numberAt(args, 0));
          break;
        case 'scale':
          context.scale(numberAt(args, 0), numberAt(args, 1));
          break;
        case 'textSize':
          context.font = `${numberAt(args, 0)}px sans-serif`;
          break;
        case 'text':
          if (fill) {
            context.fillText(
              textAt(args, 0),
              numberAt(args, 1),
              numberAt(args, 2),
            );
          }
          if (stroke && strokeWidth > 0) {
            context.strokeText(
              textAt(args, 0),
              numberAt(args, 1),
              numberAt(args, 2),
            );
          }
          break;
        default:
          paintCanvasShape(
            context,
            command.op,
            i => numberAt(args, i),
            fill,
            stroke && strokeWidth > 0,
          );
      }
    }
    previous = encoded;
  };
};
