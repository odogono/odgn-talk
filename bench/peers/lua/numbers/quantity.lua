function run(n)
  local total = 0
  for i = 1, n do total = total + (i * 1000) / 1000 end
  return math.floor(total + 0.5)
end
