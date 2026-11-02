---
type: feat
scope: repo
---

`NorthTalk.Groups` supervises long-lived Script Groups, each in its own Instance Owner and reactor instance. It finds a group by key only once the application's initialization succeeds, restarts it after a trap within its own restart budget, and stops one group without affecting any other (#1987).
