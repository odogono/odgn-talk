---
status: accepted
---

# Zone Rules are plain values that let Built-ins convert in a named zone

[ADR 0023](0023-named-time-zones-come-from-a-standard-capability.md) made fixed-offset conversion a Built-in and put named zones behind the `calendar` Capability, because the Cores ship no tz database. So a Script reaches a named zone only through `ask`, which is a statement and a call to the Host. Some Hosts evaluate Guards and other pure checks against local time, such as "raised after 22:00 at the site", where no Grant can be called. A single fixed offset passed in doesn't serve them either: it is wrong whenever a clock change falls between two Instants the Script compares.

A Host may now give a Script **Zone Rules**: a plain map copied from the Host's zone data, holding a named zone's offsets over a window of Instants. `toCivil(i, rules)` and `toInstant(c, rules [, disambiguation])` accept one where they take a fixed offset today, so local time is pure, deterministic and available in Guards. The Core still ships no zone data: the Host stamps it into the value.

- **A plain map, not a new value kind.** `{zone, until, changes}`, where `changes` is a non-empty list of `{at, offset}` with strictly increasing `at`, each before `until`. The first `at` opens the window and `until` closes it, exclusive. Each `offset` follows the fixed-offset rule: whole minutes, under 24 hr. `zone` is text used in error fields. Any other key is an error. A map needs nothing new in display, save format, Shapes or the Host boundary, and a test can write one by hand.
- **Built-ins, not `date` Library functions.** A Guard may call Built-ins but never a Library function, and Guards are where pure local time is most needed.
- **Checked whole on every call.** The Built-in validates the entire map, charging per change at the rate of other list-walking Built-ins, and a malformed map raises `out of domain` as a bad offset does. A few years of changes is about ten entries, and the answer never depends on which part of a bad map a lookup reached.
- **No extrapolation.** An Instant outside the window raises `out of range`, and so does a Civil Date with any candidate Instant outside it. A silently wrong offset is the bug this exists to prevent, and the Host chooses a window wide enough.
- **Gaps and overlaps as `calendar` resolves them.** `toInstant` takes `"compatible"` (the default), `"earlier"`, `"later"` or `"reject"`, only with Zone Rules, since a fixed offset has none. `"reject"` raises `ambiguous time` with `{civil, zone}`, so the Core now raises that code as well as `calendar` declaring it.
- **A copy as of when it was built.** Nothing refreshes Zone Rules, and a saved or stored copy keeps its data and its window ([ADR 0001](0001-value-semantics.md)). A Host that wants current data rebuilds them, for example once per Run.
- **Host builders.** Each Host API offers a builder from its own zone source, such as `zoneRules(id, from, until)` in TS. An unknown zone then fails when the Host builds the value, before any Run.

**Considered**

- *An immediate Operation called inside an expression*, such as `(ask calendar to offset t, zone)`. Rejected here: it lets expressions have effects, against why `ask` is a statement, and Guards still couldn't use it.
- *A new value kind only the Host can build.* Rejected: it needs a type, display form, save-format tag, Shape kind and boundary conversion in every Core, to gain one-time validation and protection against forgery that only misleads the forging Script.
- *Functions in the `date` Library over the map.* Rejected, because Guards can't call them.
- *Using the nearest offset, or computing from the zone's rule for later years, outside the window.* Rejected: the first gives wrong answers silently, and the second needs a rule parser for a window the Host can simply widen.
- *A `calendar` Operation that returns Zone Rules.* Left for later: every Host offering `calendar` would have to implement it, and so far the Hosts that need Zone Rules pass them in.
