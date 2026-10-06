// A loop of calls to a small function: the cost of one call and return.
const step = (acc: number, i: number) => acc + i;

export const run = (n: number) => {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total = step(total, i);
  }
  return total;
};
