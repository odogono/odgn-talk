---
type: feat
---
Deliver Store Notifications in both Session Hosts (#621). A Notification's Handler runs in the background at the same Clock reading, and the session pumps again until no Notification is left queued. `:store load` and `:store clear` are routed to watches, and `:save`/`:restore` keep router checkpoints, so a Store that changed since `:save` sends each restored watch a marker. A Host call that leaves other Host Inputs queued, such as a property getter's `deliver`, is now followed by one more Pump (#623). Routers take an optional `admitted` callback.
