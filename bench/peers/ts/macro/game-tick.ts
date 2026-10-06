const tick = (actor: { vx: number; vy: number; x: number; y: number }) => {
  actor.x += actor.vx;
  actor.y += actor.vy;
  return actor;
};

export const run = (n: number) => {
  let state = { x: 0, y: 0, vx: 1, vy: 2 };
  for (let i = 0; i < n; i++) {
    state = tick(state);
  }
  return state.x + state.y;
};
