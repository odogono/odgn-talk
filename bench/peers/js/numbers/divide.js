function run(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) total += i / 8;
  return Math.round(total * 8);
}
