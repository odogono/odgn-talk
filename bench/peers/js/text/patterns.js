const DIGITS = /[0-9]+/g;

function run(n) {
  let total = 0;
  for (let i = 0; i < n; i++) total += "a12 b345 c6".match(DIGITS).length;
  return total;
}
