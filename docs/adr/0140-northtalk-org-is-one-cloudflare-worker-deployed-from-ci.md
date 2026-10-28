# northtalk.org is one Cloudflare Worker, deployed from CI

northtalk.org is the language's public site. It is one Cloudflare Worker in `tooling/site/`. The Worker serves a static Astro + Starlight build and Folio's static build at `/folio/`, and it calls the `go-import` handler from #1513 for `/go*`. CI deploys it on every merge to `main` that touches the site or a published source file. This supersedes #1512's hand-deployed Worker. The site's prose is the repo's own Markdown, published from an explicit list of files in one config, so a doc fix also fixes the site. Every published file must therefore read well both on GitHub and on the site. The site publishes `main` only and has no version picker. The GitHub Pages Playground is retired, and Folio is the "try it" experience.

We chose this because one Worker gives one deploy, one domain and one place for the Go import paths. CI deploys keep the site in step with the docs, and the `/go` handler is small and covered by unit tests.

## Considered Options

- **Cloudflare Pages for the site plus a separate `/go*` Worker:** two projects and two deploys for no gain, since Workers serve static assets directly.
- **Hand deploys, as #1512 planned:** a docs fix would stay unpublished until someone remembered to deploy.
- **A separate copy of the content for the site:** the copy and the repo docs would drift apart.
- **VitePress or a hand-written Bun build:** VitePress is Vue-based and fits Workers less well. A hand-written build would mean building search and navigation ourselves.
