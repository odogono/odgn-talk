# Folio opens Projects from URLs

Folio, at northtalk.org/folio/, replaces the retired Playground (#1665), so docs and readers need to link to Projects. A Project opens from a URL in three ways. `/folio/<slug>` opens an Example Project: the build writes each one, still built in code, to `/folio/projects/<slug>.folio`, the service worker precaches it, and the site Worker serves Folio's page for any other path under `/folio/`. `/folio/?open=<url>` opens any `.folio` file a host serves with CORS. A Shared Link, `/folio/#p1.<deflated base64url>`, carries a whole Project in its fragment, so it never reaches a server. Share refuses a Project with assets, which is shared as a `.folio` file instead. Every way of opening adds a new copy and never overwrites the author's Projects or starts playing. Folio remembers each copy's source locally, so opening the same URL again offers the existing copy or a fresh one.

These URLs are a public contract once docs link to them, so the slug, the `?open=` parameter and the `p1` fragment format must stay readable.

## Considered Options

- **A `#example=<slug>` fragment:** works with no Worker change, but a path reads better in docs and matches the `.folio` file it loads.
- **Committing the example `.folio` files as their source:** binary zips can't be reviewed in a diff, and the code-built examples are tested.
- **Storing shared Projects on the Worker:** would allow assets in links, but brings storage, abuse handling and deletion.
- **Reading the Playground's `#v1.` links:** they stopped working when Pages was retired, and converting them would keep a format that #1666 deletes.
- **A Session Host window in Folio:** would carry the Playground's prompt and Transcripts over word for word, but would give Folio a second runtime model next to Play Sessions. Folio keeps Projects, and the Playground's `:describe`, `:apropos`, `:inspect` and `:fuel` become Message Box Session Commands.
