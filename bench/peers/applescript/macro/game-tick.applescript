on tick(actor)
	set x of actor to (x of actor) + (vx of actor)
	set y of actor to (y of actor) + (vy of actor)
	return actor
end tick

on |run|(n)
	set state to {x:0, y:0, vx:1, vy:2}
	repeat n times
		set state to tick(state)
	end repeat
	return (x of state) + (y of state)
end |run|
