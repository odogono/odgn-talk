function run(n) {
  let total = 0;
  for (let i = 0; i < n; i++) {
    for (const ch of "NorthTalk rocks!") total += ch.length;
  }
  return total;
}
