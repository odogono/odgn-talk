function run(n)
  local values = {}
  for i = 1, n do values[i] = i end
  local total = 0
  for _, v in ipairs(values) do total = total + v end
  return total
end
