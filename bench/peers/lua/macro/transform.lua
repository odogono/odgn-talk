function run(n)
  local rows = {}
  for i = 1, n do rows[i] = {price=i, quantity=2} end
  local amounts = {}
  for i, row in ipairs(rows) do amounts[i] = row.price * row.quantity end
  local total = 0
  for _, amount in ipairs(amounts) do total = total + amount end
  return total
end
