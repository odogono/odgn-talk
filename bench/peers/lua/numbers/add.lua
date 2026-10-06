function run(n)
  local total = 0
  for i = 1, n do total = total + 0.125 end
  return math.floor(total * 8 + 0.5)
end
