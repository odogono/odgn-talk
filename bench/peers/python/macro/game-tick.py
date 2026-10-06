def tick(actor):
    actor["x"] += actor["vx"]
    actor["y"] += actor["vy"]
    return actor

def run(n):
    state = {"x": 0, "y": 0, "vx": 1, "vy": 2}
    for i in range(n):
        state = tick(state)
    return state["x"] + state["y"]
