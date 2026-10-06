local function tick(actor)
  actor.x = actor.x + actor.vx
  actor.y = actor.y + actor.vy
  return actor
end

function run(n)
  local state = {x=0, y=0, vx=1, vy=2}
  for i = 1, n do state = tick(state) end
  return state.x + state.y
end
