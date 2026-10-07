function run(n)
  local original = {a=1, b=2, c=3, d=4, e=5, f=6, g=7, h=8}
  local values = {}
  for k, v in pairs(original) do values[k] = v end
  for i = 1, n do values.a = i end
  return original.a + values.a
end
