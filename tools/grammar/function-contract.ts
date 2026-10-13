import { parse } from './parser';

/** Derive arity from the Spec catalogue's call notation, using its grammar. */
export const functionContract = (call: string) => {
  const open = call.indexOf('(');
  if (open < 0 || !call.endsWith(')')) {
    return undefined;
  }
  const parsed = parse(
    `function signature ${call.slice(open + 1, -1)}\nend signature`,
  );
  if (parsed.error) {
    throw new Error(`Invalid function catalogue signature: ${call}`, {
      cause: parsed.error,
    });
  }
  const parameters = parsed.ast![0]!.params as { default: unknown }[];
  return {
    required: parameters.filter(parameter => parameter.default === null).length,
    total: parameters.length,
  };
};
