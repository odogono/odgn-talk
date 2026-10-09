function run(n) {
  const original = [-1];
  const values = [...original];
  for (let i = 1; i <= n; i++) values.push(i);
  let total = 0;
  for (const v of values) total += v;
  return total + original.length;
}
