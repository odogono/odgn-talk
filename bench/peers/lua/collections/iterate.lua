function run(n)
  local values, lookup = {}, {}
  for i = 1, 32 do values[i] = i; lookup[tostring(i)] = i end
  local total = 0
  for i = 1, n do
    for _, v in ipairs(values) do total = total + v end
    for _, v in pairs(lookup) do total = total + v end
  end
  return total
end
