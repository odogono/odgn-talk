// A counting loop: the cost of the loop itself and integer addition.
function run(n) {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    total += i;
  }
  return total;
}
