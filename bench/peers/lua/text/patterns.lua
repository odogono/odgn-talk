function run(n)
  local total = 0
  for i = 1, n do
    for hit in string.gmatch("a12 b345 c6", "[0-9]+") do total = total + 1 end
  end
  return total
end
