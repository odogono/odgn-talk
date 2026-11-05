---
type: feat
scope: repo
---
Let Elixir Hosts supply a musical clock, so their Scripts can `wait 8 bars`. `NorthTalk.Capability.musical_clock/2` makes it from a `wait` function and its cost, and `new_group/3` and `restore/4` take a Grant of it as `musical_clock:`, which every Script of the Group holds under the reserved name `musical-clock`. The package now pins `reactor-v0.20.0`, which has the Zig Core's musical clock (#2072).
