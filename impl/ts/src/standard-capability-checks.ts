// Refinements that Shapes cannot express. Kept out of Host Operation
// Declarations so an ordinary Capability cannot opt into catalogue errors.
import type { Value } from './values';

type Checks = {
  arguments?: (args: readonly Value[], binding: unknown) => void;
  error?: (code: string, data: Value) => boolean;
  result?: (value: Value, args: readonly Value[]) => boolean;
};
const checks = new WeakMap<object, Checks>();
export const registerStandardChecks = (op: object, rules: Checks): void => {
  checks.set(op, rules);
};
export const standardChecks = (op: object): Checks | undefined =>
  checks.get(op);
