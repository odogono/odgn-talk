// ADR 0116: each Operation draws on the Canvas Element it is given first.
import {
  CANVAS_SIGNATURES,
  canvasArgumentValues,
  validateCanvasArguments,
  type CanvasCommand,
} from '@northtalk/tooling/canvas';
import {
  defineCapability,
  nothing,
  shape,
  type Call,
  type HostObject,
} from '@northtalk/ts';
import { DRAWING_OPERATIONS } from '../drawing';
import { canvasShape, grantAll, type GrantDefinition } from './grant';

export type CanvasState = {
  /**
   * Where a drawing command for this Canvas Element goes; throws a
   * ScriptError for any other value.
   */
  drawingOf(canvas: HostObject): (command: CanvasCommand) => void;
};

const operations = Object.fromEntries(
  DRAWING_OPERATIONS.map(op => [
    op,
    {
      mode: 'immediate' as const,
      args: [canvasShape, ...CANVAS_SIGNATURES[op]!],
      result: shape.nothing,
      cost: { fuel: 1 },
      errors: [{ code: 'invalid canvas argument' }, { code: 'canvas limit' }],
    },
  ]),
);

export const canvasGrant: GrantDefinition<CanvasState> = {
  name: 'canvas',
  operations,
  grant: state =>
    grantAll(
      defineCapability(
        'canvas',
        Object.fromEntries(
          DRAWING_OPERATIONS.map(op => [
            op,
            {
              ...operations[op]!,
              do: (
                _call: Call<unknown>,
                target: unknown,
                ...args: unknown[]
              ) => {
                const draw = state.drawingOf(target as HostObject);
                const values = canvasArgumentValues(args);
                validateCanvasArguments(op, values);
                draw({ op, args: values.map(value => value.toString()) });
                return nothing;
              },
            },
          ]),
        ),
      ),
      undefined,
    ),
};
