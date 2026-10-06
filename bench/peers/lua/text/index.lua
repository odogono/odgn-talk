function run(n)
  local total = 0
  for i = 1, n do
    local index = i % 16 + 1
    if string.sub("NorthTalk rocks!", index, index) == "o" then total = total + 1 end
  end
  return total
end
