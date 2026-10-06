// A loop of calls to a closure that captures a local: function value calls.
export const run = (n: number) => {
  const k = 3;
  const step = (acc: number, i: number) => acc + i * k;
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total = step(total, i);
  }
  return total;
};
