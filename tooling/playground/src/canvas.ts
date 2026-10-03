import { readDisplay, type Value } from '@odgn/northtalk';
import type { CanvasCommand } from '@odgn/northtalk-tooling/canvas';

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
  const defaults = () => {
    fill = stroke = true;
    strokeWidth = 1;
    context.fillStyle = context.strokeStyle = '#000000';
    context.lineWidth = 1;
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
          context.clearRect(0, 0, canvas.width, canvas.height);
          break;
        case 'background':
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
          context.beginPath();
          if (command.op === 'line') {
            context.moveTo(numberAt(args, 0), numberAt(args, 1));
            context.lineTo(numberAt(args, 2), numberAt(args, 3));
          }
          if (command.op === 'rectangle') {
            context.rect(
              numberAt(args, 0),
              numberAt(args, 1),
              numberAt(args, 2),
              numberAt(args, 3),
            );
          }
          if (command.op === 'ellipse') {
            context.ellipse(
              numberAt(args, 0),
              numberAt(args, 1),
              numberAt(args, 2) / 2,
              numberAt(args, 3) / 2,
              0,
              0,
              2 * Math.PI,
            );
          }
          if (fill && command.op !== 'line') {
            context.fill();
          }
          if (stroke && strokeWidth > 0) {
            context.stroke();
          }
      }
    }
    previous = encoded;
  };
};
