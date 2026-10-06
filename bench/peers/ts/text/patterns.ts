const DIGITS = /\d+/g;

export const run = (n: number) => {
  let total = 0;
  for (let i = 0; i < n; i++) {
    total += 'a12 b345 c6'.match(DIGITS)!.length;
  }
  return total;
};
