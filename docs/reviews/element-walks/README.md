# Element walk approval

On 2026-10-28, the maintainer approved the first blessing of the element walk
cases in the issue-1627 conversation: “i have reviewed the cases and they are
fine”. The review also covered removing the `every-whose` and `ordinal-whose`
scripts from the approved
[`load-diagnostics/element-references`](../../../corpus/load-diagnostics/element-references/case.trace)
case, since those forms now parse.

- [`objects/element-walks`](../../../corpus/objects/element-walks/case.trace)
  pins `the elements of o` calling `Count` and then `At` for each position,
  `repeat for each` over it, `every element … whose` and `the first element …
  whose` reading every member before testing, an empty collection, and a list
  receiver raising `wrong kind`.
- [`disassembly/object-element-walks`](../../../corpus/disassembly/object-element-walks/case.toml)
  pins `list-elements` and its positions.
- [`load-diagnostics/element-walks`](../../../corpus/load-diagnostics/element-walks/case.trace)
  pins the Guard, initializer, `delimited by` and container-target diagnostics.

TS and Zig reproduce every case, and the Go API reproduces the Trace cases
through its embedded Zig reactor. The first-blessing workflow is defined in
[chapter 11](../../../spec/11-the-trace-and-conformance.md#bless).
