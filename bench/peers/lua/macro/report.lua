function run(n)
  local lines = {}
  for i = 1, n do lines[i] = string.format("item %d: %d\n", i, i * 2) end
  return #table.concat(lines)
end
