# northtalk.org shows the latest CI benchmark run as advisory

The benchmark page moves from a committed `docs/benchmarks.html` to a `/benchmarks/` page on northtalk.org ([ADR 0140](0140-northtalk-org-is-one-cloudflare-worker-deployed-from-ci.md)), built from the run results the Benchmark page workflow already commits to `bench/results/`. The site shows only the latest complete CI run: one that records it ran on CI and used no `filter` or `only`. Local runs stay in the repo unpublished, because different machines are not comparable and a partial run would look like the whole suite. Putting timings on the public site makes them read as performance claims, so the page leads with Fuel parity, the Payload and the Cost Model outliers, and labels the timings as coming from a noisy shared runner, never a promise or a ranking ([ADR 0054](0054-benchmarks-live-outside-the-cores-and-only-advise-the-cost-model.md)).

## Considered Options

- Copying `docs/benchmarks.html` into the site as is: rejected, because it would not match the site's styling or dark mode, and a generated HTML file in the repo would still go stale beside the data.
- A separate export shaped for the site: rejected, because the saved run results already hold everything the page needs, and a second format would drift from them.
