export const run = (n: number) => {
  const rows = Array.from({ length: n }, (_, i) => ({
    price: i + 1,
    quantity: 2,
  }));
  const amounts = rows.map(row => row.price * row.quantity);
  return amounts.reduce((total, amount) => total + amount, 0);
};
