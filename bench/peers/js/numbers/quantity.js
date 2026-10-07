function run(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) total += (i * 1000) / 1000;
  return Math.round(total);
}
