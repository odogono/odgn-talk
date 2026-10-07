function run(n) {
  const values = Array.from({length: 32}, (_, i) => i + 1);
  const lookup = new Map(values.map(v => [String(v), v]));
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (const v of values) total += v;
    for (const v of lookup.values()) total += v;
  }
  return total;
}
