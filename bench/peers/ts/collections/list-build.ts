export const run = (n: number) => {
  const values = [];
  for (let i = 1; i <= n; i++) {
    values.push(i);
  }
  let total = 0;
  for (const v of values) {
    total += v;
  }
  return total;
};
