function run(n)
  local total = 0
  for i = 1, n do
    for ch in string.gmatch("NorthTalk rocks!", ".") do total = total + #ch end
  end
  return total
end
