# A Host Object's Object Kind is read with a Built-in

`objectKind(o)` gives the name of the Object Kind the Host Object `o` was made with, as text. So for a door made with `group.Object(door, "d1", …)`, `objectKind(o)` is `"door"`, while `kindOf(o)` stays `"object"` (ADR 0043). It is a Built-in, so a Guard may call it, as in `on use o where objectKind(o) is "door"`. We chose this because a Script could see the Object Kind only in a Host Object's display form, `<object door "d1">`, and generic code that routes on what it holds had no way to read it. A Host-defined property can't fill that gap: a Guard may read no Host Object property but `id` (chapter 5), and an id is unique only within its kind (chapter 9), so `the id of o` alone doesn't say which object a Script holds. The Core holds each object's Object Kind beside its id, so reading it never calls the Host and can't affect parity, and it qualifies as a Built-in under ADR 0021 both because it reads a value's representation and because Guards need it. Settled in #184.

- **A disposed object still answers**, as `the id of o` and `isDisposed(o)` do, since its kind is the Core's and it stays an ordinary value (ADR 0016).
- **Anything but a Host Object** raises `wrong kind` with `expected` `"object"`, as `isDisposed` does. Unlike `kindOf`, it is defined only for one kind.
- **The name** is exactly the Object Kind's name as the Host defined it, the same text its display form shows and an Operation failure's `capability` field holds for a property (chapter 9).

## Considered Options

- **A Host-defined property, such as `the kind of o`:** each Host would have to define it on every Object Kind, a Guard couldn't read it, and reading it would call the Host.
- **A Built-in property, such as `the kind of o` or `the objectKind of o`:** a Built-in property always wins over a key (ADR 0019), so it would hide every Host's own `kind` property, as `id` already does. That clash is the one ADR 0043 avoided for map keys.
- **`o is a door`:** Object Kind names come from the Host, so they could collide with the fourteen kind names, and any other name after `is a` is a load error. It would also blur the line ADR 0043 drew between a value's Kind and a Host Object's Object Kind.
- **Folding it into `kindOf`:** rejected by ADR 0043, since `kindOf` would give names outside the Kinds table and stop agreeing with `got`.
- **Nothing for a disposed object:** the kind is Core-held data that doesn't change on disposal, and a Script tidying up after a dispose needs it as much as the id.

## Consequences

- **Built-ins:** narrows ADR 0021. `objectKind` joins the value Built-ins, a fixed Fuel charge plus the size of its result.
- **Names:** `objectKind` is a new stdlib name, unique across the Built-ins and the seven Libraries, and a Script's own names may shadow it (ADR 0034), as ADR 0043 recorded for its names.
- **Identity:** a Script can key a map by `[objectKind(o), the id of o]`, which is unique within a Group, where the id alone is not.
- **Unchanged:** `kindOf`, `is a`, the display form of a Host Object, and what a Guard may read of a Host Object's properties.
- **Conformance:** the TS Core implements it, and the Corpus case `corpus/builtins/object-kind` pins it. The Go Core doesn't exist yet (ADR 0040), and inherits that case.
