// A loop of calls to an arrow function that captures a local: function value calls.
function run(n) {
  const k = 3;
  const step = (acc, i) => acc + i * k;
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total = step(total, i);
  }
  return total;
}
