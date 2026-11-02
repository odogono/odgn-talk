// Add-on versions such as `1.2.0` (ADR 0162).

/** Compares two versions such as `1.2.0`, ignoring any `-pre` or `+build`. */
const parts = (v: string): number[] =>
  v.split(/[-+]/u)[0]!.split('.').map(Number);

export const compareVersions = (a: string, b: string): number => {
  const [x, y] = [parts(a), parts(b)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) {
      return Math.sign(d);
    }
  }
  return 0;
};
