-- A counting loop: the cost of the loop itself and integer addition.
function run(n)
  local total = 0
  for i = 1, n do
    total = total + i
  end
  return total
end
