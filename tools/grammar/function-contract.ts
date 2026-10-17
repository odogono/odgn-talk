import { parse } from './parser';

/**
 * Derive arity from the Spec catalogue's call notation, using its grammar. A
 * trailing `…` marks a variadic Built-in, which takes any number of arguments
 * after its named ones (ADR 0099).
 */
export const functionContract = (call: string) => {
  const open = call.indexOf('(');
  if (open < 0 || !call.endsWith(')')) {
    return undefined;
  }
  const { params, variadic } = variadicTail(call.slice(open + 1, -1));
  const parsed = parse(`function signature ${params}\nend signature`);
  if (parsed.error) {
    throw new Error(`Invalid function catalogue signature: ${call}`, {
      cause: parsed.error,
    });
  }
  const parameters = parsed.ast![0]!.params as { default: unknown }[];
  return {
    required: parameters.filter(parameter => parameter.default === null).length,
    total: parameters.length,
    variadic,
  };
};

/** Split a trailing `…` parameter off a catalogue parameter list. */
export const variadicTail = (params: string) =>
  params === '…' || params.endsWith(', …')
    ? { params: params.replace(/,? ?…$/, ''), variadic: true }
    : { params, variadic: false };
