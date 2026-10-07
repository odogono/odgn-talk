export const run = (n: number) => {
  let total = 0;
  for (let i = 1; i <= n; i++) {
    if ('NorthTalk rocks!'[i % 16] === 'o') {
      total++;
    }
  }
  return total;
};
