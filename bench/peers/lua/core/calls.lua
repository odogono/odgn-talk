-- A loop of calls to a small function: the cost of one call and return.
local function step(acc, i)
  return acc + i
end

function run(n)
  local total = 0
  for i = 1, n do
    total = step(total, i)
  end
  return total
end
