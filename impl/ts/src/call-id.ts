// A Capability call's id: its Run's id, `.c`, and the call's number in that
// Run, counting from 1 (chapter 11, Call ids). Built and read only here.

/** The id of a Run's `n`th call. */
export const callId = (runId: string, n: number) => `${runId}.c${n}`;

/** A call id's Run and number; undefined for anything else. */
export const parseCallId = (
  id: string,
): { n: number; runId: string } | undefined => {
  const dot = id.lastIndexOf('.c');
  const digits = id.slice(dot + 2);
  if (dot <= 0 || !/^[1-9]\d*$/.test(digits)) {
    return undefined;
  }
  return { runId: id.slice(0, dot), n: Number(digits) };
};

/** The Run that sent from `from`: the Run of a call id, or a Run id itself. */
export const senderRun = (from: string) => from.replace(/\.c\d+$/, '');

/** Call ids in the order their Runs and calls were made; other ids by name. */
export const compareCallIds = (a: string, b: string) => {
  const left = /^(.*)\/r(\d+)\.c(\d+)$/.exec(a);
  const right = /^(.*)\/r(\d+)\.c(\d+)$/.exec(b);
  if (!left || !right) {
    return compareNames(a, b);
  }
  return (
    compareNames(left[1]!, right[1]!) ||
    Number(left[2]) - Number(right[2]) ||
    Number(left[3]) - Number(right[3])
  );
};

const compareNames = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
