# Existing Fuel and retained-state changes

The following figures are extracted from the exact reviewed before/after records,
rather than regenerated expectations. Each arrow is a Run total or reported state;
the patch includes per-Stretch charges, PCs, guard order and all other changed fields.
The derivation rules and explicit boundary arithmetic are in the [review](README.md#independent-fuel-and-state-derivation).

| Expectation | Run Fuel before → after | Retained state before → after |
| --- | --- | --- |
| [builtins/function-values/case.trace](../../../corpus/builtins/function-values/case.trace) | probe/r1: 270 → 272 | unchanged |
| [builtins/object-kind/case.trace](../../../corpus/builtins/object-kind/case.trace) | router/r1: 183 → 184 | unchanged |
| [capabilities/argument-shapes/case.trace](../../../corpus/capabilities/argument-shapes/case.trace) | form/r2: 22 → 23<br>form/r3: 22 → 23<br>form/r4: 22 → 23<br>form/r5: 22 → 23<br>form/r6: 22 → 23<br>form/r7: 63 → 64 | unchanged |
| [capabilities/effect-begin-failed/case.trace](../../../corpus/capabilities/effect-begin-failed/case.trace) | s/r1: 29 → 30 | unchanged |
| [capabilities/effect-operation-error/case.trace](../../../corpus/capabilities/effect-operation-error/case.trace) | s/r1: 26 → 27 | unchanged |
| [capabilities/host-failures/case.trace](../../../corpus/capabilities/host-failures/case.trace) | shop/r1: 55 → 56<br>shop/r2: 52 → 53<br>shop/r3: 52 → 53<br>shop/r4: 52 → 53<br>shop/r5: 52 → 53<br>shop/r6: 52 → 53<br>shop/r7: 52 → 53 | unchanged |
| [capabilities/ordinary-grants/case.trace](../../../corpus/capabilities/ordinary-grants/case.trace) | s/r2: 41 → 42<br>s/r3: 22 → 23<br>s/r4: 22 → 23<br>s/r5: 54 → 55 | unchanged |
| [capabilities/revoke-in-flight/case.trace](../../../corpus/capabilities/revoke-in-flight/case.trace) | s/r1: 49 → 50 | unchanged |
| [capabilities/revoke-reissue/case.trace](../../../corpus/capabilities/revoke-reissue/case.trace) | s/r1: 49 → 50 | unchanged |
| [capabilities/scope-failed-close/case.trace](../../../corpus/capabilities/scope-failed-close/case.trace) | s/r1: 42 → 43 | unchanged |
| [capabilities/scope-slots/case.trace](../../../corpus/capabilities/scope-slots/case.trace) | s/r1: 107 → 109 | unchanged |
| [capabilities/scope-suspension-boundaries/case.trace](../../../corpus/capabilities/scope-suspension-boundaries/case.trace) | s/r1: 54 → 55<br>s/r2: 54 → 55<br>s/r3: 55 → 56<br>s/r4: 57 → 58<br>s/r5: 57 → 58<br>s/r6: 58 → 59<br>s/r7: 76 → 77 | unchanged |
| [capabilities/standard-console-timeout/case.trace](../../../corpus/capabilities/standard-console-timeout/case.trace) | s/r1: 28 → 29 | unchanged |
| [collecting/partial-error/case.trace](../../../corpus/collecting/partial-error/case.trace) | s/r1: 73 → 74 | unchanged |
| [computed-sends/bad-names/case.trace](../../../corpus/computed-sends/bad-names/case.trace) | a/r1: 938 → 954 | unchanged |
| [computed-sends/unhandled/case.trace](../../../corpus/computed-sends/unhandled/case.trace) | a/r1: 111 → 112 | unchanged |
| [disassembly/errors-and-loops/flow.dis](../../../corpus/disassembly/errors-and-loops/flow.dis) | see instruction/Stretch diff | unchanged |
| [errors/lambda-capture-parity/case.trace](../../../corpus/errors/lambda-capture-parity/case.trace) | a/r1: 104 → 105<br>a/r2: 75 → 76<br>a/r3: 58 → 59 | unchanged |
| [libraries/caller-capabilities/case.trace](../../../corpus/libraries/caller-capabilities/case.trace) | s/r4: 51 → 52 | unchanged |
| [libraries/errors/case.trace](../../../corpus/libraries/errors/case.trace) | meter/r1: 76 → 78 | unchanged |
| [limits/mailbox-depth/case.trace](../../../corpus/limits/mailbox-depth/case.trace) | sender/r1: 134 → 135 | unchanged |
| [limits/max-wait-minimum/case.trace](../../../corpus/limits/max-wait-minimum/case.trace) | waiter/r1: 47 → 48 | unchanged |
| [objects/properties/case.trace](../../../corpus/objects/properties/case.trace) | lamp/r1: 130 → 132<br>lamp/r2: 45 → 46 | unchanged |
| [save-restore/preempted-join-keeps-pending-members/case.trace](../../../corpus/save-restore/preempted-join-keeps-pending-members/case.trace) | shop/r1: 68 → 69 | 240 → 256 |
| [save-restore/settle-answer-and-fail/case.trace](../../../corpus/save-restore/settle-answer-and-fail/case.trace) | shop/r2: 142 → 143 | 356 → 372<br>364 → 380<br>612 → 644 |
| [save-restore/settle-reissue-and-adopt/case.trace](../../../corpus/save-restore/settle-reissue-and-adopt/case.trace) | shop/r1: 141 → 142 | 340 → 356<br>364 → 380<br>612 → 644 |
| [save-restore/unbound-grant-and-unresolved-object/case.trace](../../../corpus/save-restore/unbound-grant-and-unresolved-object/case.trace) | lamp/r2: 46 → 48 | unchanged |
| [save-restore/unsettled-call-is-lost/case.trace](../../../corpus/save-restore/unsettled-call-is-lost/case.trace) | shop/r2: 141 → 142 | 396 → 412<br>532 → 548<br>644 → 676<br>804 → 836 |
| [stdlib/errors-name-the-call/case.trace](../../../corpus/stdlib/errors-name-the-call/case.trace) | checks/r1: 134 → 135 | unchanged |
| [stdlib/template-migration/case.trace](../../../corpus/stdlib/template-migration/case.trace) | templates/r2: 6968 → 6973 | unchanged |
| [suspension/answers/case.trace](../../../corpus/suspension/answers/case.trace) | fetcher/r2: 74 → 75<br>fetcher/r3: 72 → 73<br>fetcher/r4: 72 → 73<br>fetcher/r5: 72 → 73 | 1005 → 1053<br>1165 → 1229<br>1253 → 1317<br>1318 → 1366<br>1501 → 1581<br>1570 → 1602<br>1802 → 1818<br>509 → 525<br>757 → 789 |
| [suspension/capability-resumption/case.trace](../../../corpus/suspension/capability-resumption/case.trace) | s/r2: 73 → 74 | unchanged |
| [suspension/join-closing-position/case.trace](../../../corpus/suspension/join-closing-position/case.trace) | a/r1: 89 → 90<br>a/r2: 106 → 107<br>a/r3: 89 → 90<br>a/r4: 106 → 107 | unchanged |
| [suspension/joins/case.trace](../../../corpus/suspension/joins/case.trace) | board/r3: 166 → 167<br>board/r4: 106 → 107<br>board/r5: 80 → 81 | 1018 → 1034<br>1115 → 1147<br>1372 → 1420<br>1406 → 1454<br>728 → 744<br>782 → 798<br>895 → 927 |
| [suspension/nested-waits/case.trace](../../../corpus/suspension/nested-waits/case.trace) | napper/r3: 32 → 33 | unchanged |
| [suspension/script-joins/case.trace](../../../corpus/suspension/script-joins/case.trace) | a/r3: 147 → 148 | 464 → 480<br>488 → 504<br>608 → 624 |
| [suspension/script-sends/case.trace](../../../corpus/suspension/script-sends/case.trace) | a/r1: 151 → 152<br>a/r2: 54 → 55<br>a/r3: 84 → 85 | unchanged |
| [suspension/send-and-wait/case.trace](../../../corpus/suspension/send-and-wait/case.trace) | front/r2: 45 → 46<br>front/r3: 45 → 46<br>front/r4: 45 → 46 | 1148 → 1196<br>1190 → 1238<br>1388 → 1420<br>1438 → 1502<br>1601 → 1617<br>470 → 486<br>690 → 722 |
| [suspension/send-reply-preemption/case.trace](../../../corpus/suspension/send-reply-preemption/case.trace) | a/r1: 57 → 58 | 994 → 1988 |
| [text-model/chunk-write-out-of-range/case.trace](../../../corpus/text-model/chunk-write-out-of-range/case.trace) | writes/r1: 215 → 220 | unchanged |
| [text-patterns/splice-wrong-kind/case.trace](../../../corpus/text-patterns/splice-wrong-kind/case.trace) | splice/r1: 51 → 52 | unchanged |
| [capabilities/standard-store-errors/case.trace](../../../corpus/capabilities/standard-store-errors/case.trace) | s/r7: 57 → 58 | unchanged |
