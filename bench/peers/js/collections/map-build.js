function run(n) {
  const values = new Map();
  for (let i = 1; i <= n; i++) values.set(String(i), i);
  let total = 0;
  for (const v of values.values()) total += v;
  return total;
}
