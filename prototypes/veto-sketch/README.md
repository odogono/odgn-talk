# PROTOTYPE: decisions and vetoes (throwaway)

For [Decision-mode (veto) dispatch, with a Host that actually vetoes](https://github.com/odogono/odgn-talk/issues/80).

Open `veto.html` by double-clicking it. It is one self-contained file with no build step and no server.

- **The model** is the first `<script>` block: a pure Pump over a small Script Group (mailboxes, Runs, Fuel Slices, Core-held parents, Broadcast) with decisions added. Handler bodies are step lists that stand in for real statements, and each one is shown beside its `.talk` source.
- **The page** is the second block: a thin shell with guided walkthroughs, free-play buttons, the Host's view (decisions and reports), each Script's state, and the Trace.
- **Two Hosts veto:** a board game asks piece Scripts and the board "may this piece make this move?", and a sign-up form broadcasts "may this be submitted?" to its field validators.

[`FINDINGS.md`](FINDINGS.md) has the answers. Where they disagree with an ADR on `main`, the ADR wins.
