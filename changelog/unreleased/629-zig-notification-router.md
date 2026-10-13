---
type: feat
---
Add the Store Notification router to the Zig Core's `talk.h`. Hosts can now hold `store` watches, route commits to them, retry Notifications a full mailbox refused after each Pump, and take and restore checkpoints, resyncing watches on Stores that changed. `talk.h` also gains `talk_call_group`, `talk_script_names`, `talk_changed` and the `invalid checkpoint` Host error (#629).
