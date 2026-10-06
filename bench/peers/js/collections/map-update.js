function run(n) {
  const original = new Map([["a", 1], ["b", 2], ["c", 3], ["d", 4], ["e", 5], ["f", 6], ["g", 7], ["h", 8]]);
  const values = new Map(original);
  for (let i = 1; i <= n; i++) values.set("a", i);
  return original.get("a") + values.get("a");
}
