---
type: feat
---
Return the reports of each Pump, Reload and Library replacement from the Zig Core, as `talk_reports` in `talk.h`: each Run's end with its result, error or limit, Stops, unhandled messages, failed calls, effect failures, sealed Decisions and refused queued inputs, with the Pump's next deadline. The corpus runner now reads Function Values from Run results, so `functions/capability-callbacks` passes (#629).
