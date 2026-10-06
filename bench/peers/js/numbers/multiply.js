function run(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) total += 1.25 * i;
  return Math.round(total * 8);
}
