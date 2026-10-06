-- A loop of calls to a closure that captures a local: function value calls.
function run(n)
  local k = 3
  local step = function(acc, i) return acc + i * k end
  local total = 0
  for i = 1, n do
    total = step(total, i)
  end
  return total
end
