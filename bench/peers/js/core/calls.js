// A loop of calls to a small function: the cost of one call and return.
function step(acc, i) {
  return acc + i;
}

function run(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total = step(total, i);
  }
  return total;
}
