# northtalk.org

The language's public site ([#1659](https://github.com/odogono/odgn-talk/issues/1659), [ADR 0140](../../docs/adr/0140-northtalk-org-is-one-cloudflare-worker-deployed-from-ci.md)). It is an [Astro](https://astro.build/) + [Starlight](https://starlight.astro.build/) build served by one Cloudflare Worker. Like the rest of `tooling/`, none of it is normative.

## Running it

From the repository root, after `bun install`:

```sh
bun run --cwd tooling/site dev     # sync the published files and serve with live reload
bun run --cwd tooling/site build   # write dist/, then fail on any broken site link or anchor
bun run --cwd tooling/site preview # serve dist/ through the Worker with wrangler dev
bun run --cwd tooling/site test    # the link-rewriting tests
```

## Published files

The site's prose is the repo's own Markdown. [`src/sources.ts`](src/sources.ts) lists every published file and its site path. `bun run --cwd tooling/site sync` (part of `dev` and `build`) copies each listed file into `src/content/docs/generated/`, which is git-ignored. It turns the first `#` heading into the page title, points links between listed files at their site pages, and points links to any other repo path at GitHub. Files that aren't listed are not published.

**A listed file is read in two places.** If you edit the tour, the spec, the Glossary or a Host guide, it must still read well on GitHub and on northtalk.org. Write relative links to repo files as usual; the sync rewrites them. To publish another file, add it to `src/sources.ts` and the sidebar in [`astro.config.mjs`](astro.config.mjs).

Site-only pages, such as the home page and the Examples page that links each Example Project in Folio, live in `src/content/docs/` itself. `talk` code blocks are highlighted with the [VS Code extension's grammar](../vscode/syntaxes/northtalk.tmLanguage.json).

## The Worker

[`wrangler.jsonc`](wrangler.jsonc) binds the Worker to `northtalk.org` and serves `dist/` as static assets. [`src/worker.ts`](src/worker.ts) handles the paths listed under `assets.run_worker_first`. Those are the Go module paths, which [`src/go-import.ts`](src/go-import.ts) serves ([#1512](https://github.com/odogono/odgn-talk/issues/1512)). `go get` reads a `go-import` tag naming the repo and the module's directory, and browsers are redirected to pkg.go.dev. Other paths, such as `/gopher`, never reach the Worker. The build also builds [Folio](../creative/) and copies it to `dist/folio/`, so the site serves it at `/folio/`. Folio's URLs are all relative, so its service worker is scoped to `/folio/` and leaves the docs alone. 

## Deploying

The [northtalk.org workflow](../../.github/workflows/site.yml) builds and deploys the Worker on each push to `main` that changes the site, Folio or a published file ([#1663](https://github.com/odogono/odgn-talk/issues/1663)). It can also be run by hand from the Actions tab. To deploy from a checkout instead, run `bun run build && bunx wrangler deploy` here after `bunx wrangler login`.

**Analytics:** pages built with `CF_WEB_ANALYTICS_TOKEN` set include the Cloudflare Web Analytics beacon, which is cookieless. CI sets it from the repo variable of the same name. Local builds and Folio leave it out.
