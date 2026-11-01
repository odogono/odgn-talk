# A Host Object may be given its parent when it is made

`group.object(kind, id, native, {parent})` makes a Host Object that already has its parent. Making an object is immediate, even inside a Pump, but `setParent` is a queued Host Input ([ADR 0016](0016-messages-reach-scripts-through-core-owned-object-parents.md)). So a Host that makes Handles lazily, the first time a Host function hands one to a Script, couldn't parent it before a later Pump drained the change. A Script that got the object and sent to it in the same Run found no Owning Script on its Message Path, and the message was `unhandled` (#1876). Giving the parent at creation reorders nothing, because a new object has no mailbox messages, no earlier parent and no queued changes.

```ts
// Inside an Operation's do: the room's Handle is made with its parent, so a
// send to it in this Run reaches the room's Owning Script.
const room = group.object(Room, roomId, native, { parent: zoneHandle });
```

- **Checks at the call:** the parent must be one of the Group's handles, or `wrong group`, and not disposed, or `invalid value`. A new object can't be its own ancestor, so there is no cycle check. A refused call makes no object, and the id stays free. `parentKinds` is still for the Host Manifest only, as for `setParent`.
- **Later changes** still go through the queued `setParent`, so re-parenting an object that already exists keeps its place among queued Host Inputs.
- **The Trace:** making an object with a parent writes an `object` record with `object` and `parent` at the call, inside the crossing that made it. It isn't a Host Input, and replay doesn't perform it: the runner makes the object again as the case describes, and the Core writes the record again. Making an object without a parent writes nothing, as before.
- **The message layer:** the `object` message gains an optional `parent`.
- **Save and Restore** need nothing new: an object's parent is already saved with it, however it was set.

## Considered Options

- **Applying `setParent` at once when a Host function calls it:** it would also cover re-parenting an object that already exists in the middle of a Run. But a Segment rollback would have to undo the change, messages already on the object's path would be re-routed mid-Run, and the same call would act at once or queue depending on where it was made. Nothing needs mid-Run re-parenting yet.
- **Documenting that a Host must parent objects before the Pump that can reach them:** this needs no change, but it forces Adapters to make a Handle for every entity that has a Script before each Pump. That grows with the world, and every Adapter that makes objects lazily would have to find it out.
- **Recording every object creation in the Trace:** it would show when parentless objects are made too, but it would change every existing Trace, and a parentless object changes nothing until a Host Input or a Script refers to it.

## Consequences

- **Both Cores** take the option and write the record, and the Host APIs follow: TS (`talk.ts`), Go (`talk.go`, `Object` with an option), the C API and its Zig exports, and the message layer, with a new optional field in `envelope.toml` and its codecs. The Elixir embedding re-pins the reactor once Zig has it.
- **The corpus** gains a way for an Operation to make an object when it is called, given in `case.toml`, and a case in which an Operation makes a parented object and the same Run sends to it.
- **Host Adapters** that make Handles lazily, such as ecs-talk's, pass the parent when they make the Handle and drop the eager Handle-per-entity workaround.
