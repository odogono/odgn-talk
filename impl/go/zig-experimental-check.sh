#!/bin/sh
# First public-interface slice only. Full API/facility/Corpus parity is a later gate.
set -eu
cd "$(dirname "$0")"
selection='^(TestZigBackend.*|TestRequestExecutionAndWorkerRefusals|TestFailedInitialiserHasItsInstructionPosition|TestMailboxReservationIncludesQueuedInputs|TestSliceDebtAndPumpRoundRobin|TestPumpAcceptsClockBoundariesAndRefusesDecrease|TestWaitReleasesScriptAndResumesAfterInputs|TestRunawayScriptFaultPreservesOtherScriptsAndCommittedSegments|TestWaitFuelFaultDoesNotChargeOrInstallTimer|TestOverrideRejectsUnknownPresenceBits)$'
exec go test -tags talk_zig_experimental -run "$selection" -count=1 "$@" .
