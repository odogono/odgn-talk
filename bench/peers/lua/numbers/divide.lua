function run(n)
  local total = 0
  for i = 1, n do total = total + i / 8 end
  return math.floor(total * 8 + 0.5)
end
