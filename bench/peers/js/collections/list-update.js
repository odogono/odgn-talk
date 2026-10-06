function run(n) {
  const original = [1, 2, 3, 4, 5, 6, 7, 8];
  const values = [...original];
  for (let i = 1; i <= n; i++) values[0] = i;
  return original[0] + values[0];
}
