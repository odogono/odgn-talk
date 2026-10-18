---
type: feat
scope: tools
---
End a Playground session whose worker doesn't answer Cancel, Restart or Run fresh within 500 ms, and start a fresh session in a new worker from the setup and the tabs, without the launch line. Before, a Script that never yielded left the session unresponsive until the page was reloaded. The supervisor is `@northtalk/tooling/worker-supervisor`, for any browser Host that runs in a worker.
