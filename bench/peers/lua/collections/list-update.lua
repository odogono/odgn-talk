function run(n)
  local original = {1, 2, 3, 4, 5, 6, 7, 8}
  local values = {}
  for k, v in ipairs(original) do values[k] = v end
  for i = 1, n do values[1] = i end
  return original[1] + values[1]
end
