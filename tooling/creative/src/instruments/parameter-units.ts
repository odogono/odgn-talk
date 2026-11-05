// Instrument parameters in Catalogue Units (ADR 0166, #2067): a number
// parameter that names a Unit, such as the synth's `cutoff` in `Hz`, also
// takes any Quantity of that Unit's Kind, such as `2 kHz`, and keeps it as a
// plain number in its Unit, so saved Projects stay plain numbers.
import { shape, units, type Value } from '@northtalk/ts';
import type { ParameterDefinition } from './kind';

/** Each Catalogue Unit's Kind and factor, by name. */
const UNITS = new Map(
  units.map(unit => [
    unit.name,
    {
      kind: unit.kind,
      factor: Number(unit.factor[0]) / Number(unit.factor[1]),
    },
  ]),
);

/** The Unit a number parameter reads plain numbers in, if the Catalogue has it. */
const parameterUnit = (definition: ParameterDefinition) =>
  definition.shape === 'number' && definition.unit !== undefined
    ? UNITS.get(definition.unit)
    : undefined;

/**
 * A parameter's Shape: a number parameter with a Unit also takes any
 * Quantity of that Unit's Kind, so `cutoff` takes `800` or `2 kHz` (ADR
 * 0166), and the Core refuses `800 ms` as `wrong kind`.
 */
export const parameterShape = (definition: ParameterDefinition) => {
  if (definition.shape === 'number') {
    const unit = parameterUnit(definition);
    return unit
      ? shape.oneOf(shape.number, shape.quantityKind(unit.kind))
      : shape.number;
  }
  return definition.shape === 'boolean' ? shape.bool : shape.text;
};

/**
 * A number parameter's value as a plain number in its Unit. The Shape has
 * already admitted only a number or a Quantity of the Unit's Kind; the
 * result is rounded to 15 significant digits, so `1.1 kHz` is 1100.
 */
export const parameterNumber = (
  definition: ParameterDefinition,
  value: Value,
) => {
  const quantity = value.asQuantityRef();
  if (!quantity) {
    return value.asDecimal()!.toNumberLossy();
  }
  const from = UNITS.get(quantity.unit[0]!.unit)!;
  const to = parameterUnit(definition)!;
  return Number(
    ((quantity.number.toNumberLossy() * from.factor) / to.factor).toPrecision(
      15,
    ),
  );
};
