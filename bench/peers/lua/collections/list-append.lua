function run(n)
  local original = {-1}
  local values = {original[1]}
  for i = 1, n do values[#values + 1] = i end
  local total = 0
  for _, v in ipairs(values) do total = total + v end
  return total + #original
end
