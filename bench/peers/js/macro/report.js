function run(n) {
  const lines = [];
  for (let i = 1; i <= n; i++) lines.push(`item ${i}: ${i * 2}\n`);
  return lines.join("").length;
}
