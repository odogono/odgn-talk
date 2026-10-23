// A Host Clock that leaves out paused time and never goes backwards. The
// Stack's live debugger and Folio's Play worker pump with it (ADR 0128).

/**
 * Wraps `now`, epoch microseconds, so its readings exclude the paused
 * milliseconds `pausedTime` reports beyond its reading when the clock is made.
 */
export const pausableClock = (
  now: () => bigint,
  pausedTime: () => number,
): (() => bigint) => {
  const baseline = pausedTime();
  let last: bigint | null = null;
  return () => {
    const reading =
      now() - BigInt(Math.floor((pausedTime() - baseline) * 1000));
    // Coarse Host clocks and separately sampled monotonic paused time can
    // otherwise regress by a fraction of a millisecond after a pause.
    if (last === null || reading > last) {
      last = reading;
    }
    return last;
  };
};
