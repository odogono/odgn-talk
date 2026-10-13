# Project files and browser storage for the creative tool

Answers [#739](https://github.com/odogono/odgn-talk/issues/739), part of [#154](https://github.com/odogono/odgn-talk/issues/154). The creative tool autosaves a Project in the browser and exports it as a portable file that a recipient opens in the same application. This note settles the file format and its versioning, how image and audio assets are stored, where autosave lives and how it behaves, how failures are reported, how files reach and leave the disk, and what offline use needs. Both the file and autosave hold the authored Project only, never Play State ([ADR 0041](../adr/0041-authored-projects-are-separate-from-temporary-play-state.md)). A Project file is not a Script Snapshot. Browser versions below come from [MDN's browser-compat-data](https://github.com/mdn/browser-compat-data) as of October 2026, the source behind MDN's compatibility tables.

## Summary

- **The Project file is a zip.** It holds a `mimetype` entry, a `project.json` model and one file per asset, named by its SHA-256 hash. A zip stores images and audio as raw bytes, while a single JSON file must base64 them, which adds a third to their size. It can be read one entry at a time, and anyone can open it with an ordinary unzip tool to inspect or repair it. The browser can write and read one with no dependency: `CompressionStream("deflate-raw")` is in every target browser.
- **The format has one integer version.** The app migrates older files step by step on open. It refuses to open a newer file, says why, and never overwrites it.
- **Assets are PNG, JPEG, WebP, GIF and SVG images, and MP3 or AAC (`.m4a`) audio.** These play in every current target browser. AVIF, Ogg and WAV are accepted with a warning about older browsers. SVG is only ever shown through `<img>`, where scripts don't run. Each asset is stored once, keyed by its SHA-256.
- **Autosave uses IndexedDB only.** One transaction writes the model and any new assets together, so a save is all or nothing. The Origin Private File System (OPFS) adds no needed feature: its `createWritable()` reached Safari only in version 26, and its fast access handle works only in workers.
- **Local storage is not a backup.** Chrome and Firefox evict best-effort data under storage pressure. Safari deletes all script-written storage after seven days of use without a visit, unless the site is a Home Screen or Dock web app. The app asks for `navigator.storage.persist()`, shows whether it was granted, and reminds the author to export.
- **Autosave writes about a second after the last edit, and at once when the page is hidden.** It keeps the last few versions of the model for recovery. A Web Lock lets only one tab edit a Project at a time.
- **No failure loses work silently.** The in-memory Project stays the source of truth until a write succeeds. A failed or over-quota write shows a lasting banner with an Export button. A broken import never replaces anything, and a missing asset opens as a visible placeholder.
- **Save to disk is a download everywhere.** Chrome and Edge also get Save back to the same file through `showSaveFilePicker()`. Firefox and Safari don't support it. Import uses `<input type="file">` and drag-and-drop everywhere.
- **Offline needs a service worker that caches the app shell.** Updates wait for the author to reload, after autosave has flushed.
- **Recommendation:** adopt the zip layout, versioning and IndexedDB autosave below for stage 1, with a small zip reader and writer of our own rather than a library. Defer the service worker, `file_handlers` and Save-in-place to stage 3, since stage 1 can ship without them.

## 1. The Project file format

### Zip compared with single JSON

| | Zip of JSON and asset files | Single JSON with base64 assets |
|---|---|---|
| Size | Assets as raw bytes. Model deflated. | Base64 turns every 3 bytes into 4 characters ([RFC 4648 §4](https://www.rfc-editor.org/rfc/rfc4648#section-4)), so assets grow by a third. |
| Streaming | Each entry can be read alone, using the central directory. | The whole file must be parsed at once, so a 200 MB Project needs a 270 MB string in memory. |
| Browser support | Deflate through [Compression Streams](https://compression.spec.whatwg.org/). Zip framing written by hand. | `JSON.parse` only. |
| Inspection and repair | Any unzip tool lists the assets and shows `project.json`. | A text editor opens it, but long base64 lines make that awkward. |

The zip wins on every row except the code it needs.

### Can the browser write a zip with no dependency?

Yes:

- The [Compression Standard](https://compression.spec.whatwg.org/) defines `"deflate-raw"`, raw DEFLATE with no header. That is exactly what zip's method 8 stores. `CompressionStream` with `"deflate-raw"` is in Chrome 103, Firefox 113 and Safari 16.4 (iOS too).
- The standard has no zip support of its own. The archive framing is ours to write: local headers, central directory and end record ([PKWARE APPNOTE 6.3.9](https://pkwaredownloads.blob.core.windows.net/pkware-general/Documentation/APPNOTE-6.3.9.TXT), §4.3).
- Every entry needs a CRC-32 (APPNOTE §4.1.5: it "MUST be provided for each file"). Raw deflate has no checksum, so we compute it ourselves. A table-driven CRC-32 is about 15 lines.
- Images and audio are already compressed, so they are stored (method 0). Only `project.json` is deflated (method 8).

Reading is the harder half. A hand-edited and re-zipped file may come from any tool, so the reader must accept:

- general-purpose flag bit 3, where sizes and CRC follow the data in a data descriptor (APPNOTE §4.3.9);
- the UTF-8 name flag, bit 11 (§4.4.4).

Reading through the central directory, not the local headers, handles bit 3 for free. The reader rejects encryption, methods other than 0 and 8, and ZIP64. ZIP64 is needed only past 4 GiB or 65,535 entries (§4.4.1.4), and a Project should never get near either.

[fflate](https://github.com/101arrowz/fflate) is the fallback if our reader proves fragile. It is MIT licensed and has no runtime dependencies ([`package.json`](https://github.com/101arrowz/fflate/blob/master/package.json)). Its README gives about 8 kB minified for the core, and an extra 3 kB for zip. The Playground's only dependencies are CodeMirror, Lezer and our own packages ([`tooling/playground/package.json`](../../tooling/playground/package.json)). A zip subset of a few hundred lines that we own fits that better.

The zip code uses only web platform APIs (`CompressionStream`, `Blob`, `Uint8Array`), so it also runs under Node, Deno and Bun for tests.

### Layout

```text
mimetype                       stored, first entry, no extra field
project.json                   deflated
assets/3f7a…c1.png             stored
assets/9b02…e4.mp3             stored
```

- **`mimetype`** holds the media type in ASCII. This follows EPUB's OCF container, which requires a `mimetype` file that is the first entry, uncompressed and without an extra field ([EPUB 3.3 §4.3.3](https://www.w3.org/TR/epub-33/#sec-zip-container-mime)). A file sniffer can then identify the file from fixed byte offsets. EPUB also limits itself to methods 0 and 8, UTF-8 names and no zip encryption ([§4.3.2](https://www.w3.org/TR/epub-33/#sec-zip-container-zipreqs)). We adopt the same limits.
- **`project.json`** holds the format version and the whole authored Project:
  - Pages and their order;
  - Elements, with their identifier names and properties ([#735](https://github.com/odogono/odgn-talk/issues/735#issuecomment-6142278126));
  - rich-text runs;
  - the Script source of the Project, each Page and each Element;
  - an asset table mapping each asset's name, as Scripts use it in `image` and `sound`, to its hash, media type, byte size and original file name.

  It holds no Play State and no Script Variables.
- **`assets/<sha256>.<ext>`:** one file per distinct content. The extension is for people unzipping by hand. The app trusts the asset table, not the extension.

### Extension and media type

- **Media type:** `application/vnd.odgn.northtalk-project+zip`. The `+zip` suffix says the content follows `application/zip` ([RFC 6839 §3.6](https://www.rfc-editor.org/rfc/rfc6839#section-3.6)).
- **Extension:** waits for the application's name, which is still in #154's Fog. A short, distinctive extension is wanted. A plain `.zip` is not, because the OS would open it in an archive tool.

## 2. Versioning

- **`format` is one integer** in `project.json`, starting at 1, plus `app` (the writing app's version) for diagnostics only. The `mimetype` stays fixed across versions.
- **Opening an older file:** the app runs migrations `n → n+1` in order, in memory. The original file is never touched. Migrations are pure functions over the parsed JSON, so each gets a fixture test: an old file in, the expected new model out.
- **Opening a newer file:** the app refuses it. "This Project was made with a newer version of the app (format 3; this app reads up to 2). Reload to update." The app never opens it read-only and never saves it back. Doing either would silently drop fields this version doesn't know.
- **Autosave records the same `format`.** The app migrates autosaved Projects on start, as it does imported files, after keeping a copy of the old record (see Previous versions in section 5).
- **Additive changes:** a new optional property with a default still bumps `format`. That way an older app refuses the file rather than losing the property. This is stricter than "ignore unknown fields". Given the "without silently losing authored work" acceptance check in #154, refusing is the safer default.

## 3. Assets

### Formats that play everywhere

Images (MDN's [image type guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Image_types)):

| Format | Chrome | Firefox | Safari | Advice |
|---|---|---|---|---|
| PNG, JPEG, GIF, SVG | all | all | all | Accept. |
| WebP | all | all | 14, with macOS 11 or later | Accept. |
| APNG | 59 | 3 | 8 | Accept, as PNG. |
| AVIF | 85 | 93 | 16.1 | Accept, with a warning that older Safari can't show it. |

Audio:

| Format | Support | Advice |
|---|---|---|
| MP3 (`audio/mpeg`) | Every target browser. Safari since 3.1 ([audio codecs guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Audio_codecs)). | Accept; recommended. |
| AAC in MP4 (`.m4a`) | MDN's single best choice when only one format can be offered. Firefox decodes it through the operating system ([containers guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)). | Accept. |
| Ogg Opus or Vorbis | Safari only from 18.4 on macOS 15.4 and iOS 18.4 ([WebKit, Safari 18.4](https://webkit.org/blog/16574/webkit-features-in-safari-18-4/)). | Accept, with a warning. |
| WAV (PCM) | MDN's tables don't cover playback by browser. Files are large. | Accept, with a size warning. |
| FLAC | "Not supported at all on iOS" ([containers guide](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats/Containers)). | Refuse, and suggest MP3. |

On import, the app checks that each asset really decodes, rather than trusting the extension. Images use `createImageBitmap` or `img.decode()`. Audio uses `audio.canPlayType()` plus a trial decode. A file that doesn't decode is refused with its name and the reason.

### Size limits

No primary source sets these, so they are a judgement:

- Warn above 10 MB for one asset. Refuse above 50 MB.
- Show the Project's total size in the export dialog.

The reasons:

- `SubtleCrypto.digest()` can't stream, so "the entire input must be in memory" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)).
- Phones play these files, and on a phone memory is the binding limit.
- The zip format's own 4 GiB limit is never reached.

### Content-hash dedupe

- `crypto.subtle.digest("SHA-256", bytes)` gives the key. It is Baseline since January 2020, works in workers, and needs a secure context ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/digest)). `localhost` counts as a secure context, so development is unaffected.
- The same image imported twice, or used by duplicated Pages, is stored once. The asset table maps names to hashes, so two names may share one file.
- Unused assets are dropped from the export. In storage, the app removes them when no kept version of the model refers to them (see section 5).

### SVG safety

- An SVG is XML and may contain scripts. Used as an image, "JavaScript is disabled" and external resources aren't loaded. These restrictions "don't apply when SVG content is viewed directly, or when it's embedded as a document via the `<iframe>`, `<object>`, or `<embed>` elements" ([MDN, SVG as an image](https://developer.mozilla.org/en-US/docs/Web/SVG/Guides/SVG_as_an_image)).
- So the app shows an SVG only through `<img src>` or CSS `background-image`. It never inlines one into the DOM and never puts one in `<object>` or `<iframe>`.
- **Blob URLs need care.** A `blob:` URL has the origin of the page that created it ([File API §8.3.1](https://w3c.github.io/FileAPI/#originOfBlobURL)), and top-level navigations to one are allowed ([§8.3.2](https://w3c.github.io/FileAPI/#partitioningOfBlobUrls)). An SVG opened directly from a `blob:` URL would therefore run its scripts with the app's origin, and could read the author's storage. The app must offer no "open image in new tab" path for SVG assets. For defence in depth, it should send a strict `Content-Security-Policy` with the app shell.

## 4. Local storage for autosave

### IndexedDB, OPFS or both

**IndexedDB alone.** The reasons:

- **Atomic across model and assets.** An IndexedDB transaction "represents an atomic and durable set of data access and data mutation operations". On failure, none of its changes are written ([IndexedDB 3.0](https://w3c.github.io/IndexedDB/)). One transaction can add new asset Blobs and the new model together. With OPFS plus IndexedDB, a crash between the two writes leaves them out of step.
- **Stores Blobs directly.** Values may be any serializable object, "including File objects, Blob objects" (same spec).
- **OPFS writes reached Safari late.** `getDirectory()` is in Chrome 86, Firefox 111 and Safari 15.2. But `FileSystemFileHandle.createWritable()`, the main-thread write path, arrived only in Safari 26. `createSyncAccessHandle()` is `[Exposed=DedicatedWorker]` ([File System Standard](https://fs.spec.whatwg.org/)), so the alternative on older Safari is a worker.
- **Same quota and same eviction.** Both live in the same storage bucket, which "must be cleared in its entirety" ([Storage Standard §7](https://storage.spec.whatwg.org/)). OPFS buys no extra safety.

OPFS is worth revisiting only if large audio makes Blob reads from IndexedDB slow in practice.

The Playground's [`storage.ts`](../../tooling/playground/src/storage.ts) uses `localStorage`, which suits its small text buffers. It doesn't suit Projects: Web Storage is synchronous and string-only ([web.dev, Storage for the web](https://web.dev/articles/storage-for-the-web)), and is capped at about 5 MiB per origin ([MDN, quotas](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)). Its pattern of validating each field on load and treating a failure as "nothing saved" carries over.

### Suggested stores

- **`projects`:** one record per Project, with its id, title, `format`, last-modified time and last-exported time.
- **`versions`:** keyed by `[projectId, seq]`. Each record holds the whole `project.json` model. The newest is the current autosave, and older ones are kept for recovery.
- **`assets`:** keyed by SHA-256, holding a Blob and a media type.

### Quotas

From [MDN's quotas page](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria) and [WebKit's storage policy](https://webkit.org/blog/14403/updates-to-storage-policy/):

| Browser | Quota per origin |
|---|---|
| Chrome, Edge | Up to 60% of total disk, best-effort or persistent. |
| Firefox | Best-effort: the smaller of 10% of disk and 10 GiB, shared by the whole site. Persistent: up to 50% of disk. |
| Safari 17 and later | Up to about 60% of disk in Safari, and the same for Home Screen and Dock web apps. Across all origins, at most 80% of disk. Safari no longer prompts for more space. |

The quota is far above any Project we expect. Eviction is the real risk, not the quota. `navigator.storage.estimate()` gives a rough usage and quota figure, which the app shows in its storage panel. Its usage figure is "implementation-defined" and only an estimate ([Storage Standard §6](https://storage.spec.whatwg.org/)).

### Eviction and persistence

- **Best-effort is the default.** Under storage pressure, user agents clear best-effort buckets, least recently used first ([Storage Standard §7.1](https://storage.spec.whatwg.org/); [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)). Persistent buckets are cleared only with the user's involvement.
- **Safari's seven-day cap:** Safari deletes "all of a website's script-writable storage after seven days of Safari use without user interaction on the site". That covers IndexedDB, LocalStorage, and service worker registrations and caches ([WebKit, Full Third-Party Cookie Blocking and More](https://webkit.org/blog/10218/full-third-party-cookie-blocking-and-more/)). Home Screen web apps "are not part of Safari and thus have their own counter of days of use", and WebKit does "not expect the first-party in such a web application to have its website data deleted" (same post). WebKit's [tracking prevention page](https://webkit.org/tracking-prevention/) puts it as "the first-party domain of home screen web applications is exempt from ITP's 7-day cap". MDN says this proactive eviction applies when cross-site tracking prevention is on ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)).
- **How `persist()` is granted:**
  - Chrome decides silently, from site engagement, whether the site is installed or bookmarked, and whether it has notification permission ([web.dev, Persistent storage](https://web.dev/articles/persistent-storage)).
  - Firefox asks the user with a prompt (same article).
  - Safari decides by heuristics, such as whether the site is opened as a Home Screen web app ([WebKit](https://webkit.org/blog/14403/updates-to-storage-policy/)).

  Persistent data is "kept by the browser, even if storage is running low" (web.dev). It is not exempt from the user clearing it.
- **What the app does:**
  - Call `persist()` after the first real edit, not on page load. In Firefox, that makes the prompt follow an obvious reason.
  - Show the result in the storage panel: "Kept until you clear it" or "The browser may clear this".
  - When `persist()` is refused, or in Safari outside an installed web app, show an "Export a copy" reminder once the Project has changed since its last export. The `projects` store records the last-exported time for this.

## 5. Autosave behaviour

### When to write

- About 1 s after the last edit, and at most every 5 s during a continuous drag. Undo steps don't wait for a write.
- At once when `document.visibilityState` becomes `hidden`. MDN calls that "the last event that's reliably observable by the page" ([MDN, visibilitychange](https://developer.mozilla.org/en-US/docs/Web/API/Document/visibilitychange_event)).
- Never during Play. Play State is never written (ADR 0041). Autosave keeps writing the authored Project, which Play doesn't change.

### Atomicity

- One `readwrite` transaction puts the new asset Blobs and the new `versions` record, and updates `projects`. Either all of it commits or none does.
- The model is serialised before the transaction opens. An IndexedDB transaction commits on its own once no requests are pending ([IndexedDB](https://w3c.github.io/IndexedDB/)), so any `await` on unrelated work inside it ends it early.
- The transaction may use the `durability` hint: `"strict"` waits until changes reach "a persistent storage medium", and `"relaxed"` does not ([IndexedDB](https://w3c.github.io/IndexedDB/)). The hint is in Chrome 83, Firefox 126 and Safari 15. Use the default for routine saves. `"strict"` is worth its cost only for the write before a migration or an import.
- If OPFS is ever used, its `createWritable()` writes to a temporary file. The original is replaced only "when the writable file stream is closed" ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/FileSystemFileHandle/createWritable); [File System Standard](https://fs.spec.whatwg.org/)). So a write-then-rename isn't needed there.

### Previous versions

- Keep the last 20 `versions` records, plus one per hour for the last day. The model is small, so this costs little.
- Each record is a whole model, not a diff, so any record can be restored on its own.
- Assets are shared through their hashes. After trimming versions, the app deletes any asset no kept version refers to, in the same transaction.
- A "Restore earlier version" list shows the time and Page count of each record. Restoring writes a new newest record, so the restore can itself be undone.

### Several tabs

- Each tab asks for an exclusive Web Lock named after the Project, with `ifAvailable: true`. Locks are shared across tabs and workers of one origin. A lock is released when its document unloads ([Web Locks](https://w3c.github.io/web-locks/)). Web Locks are in Chrome 69, Firefox 96 and Safari 15.4.
- A tab that doesn't get the lock opens the Project read-only, with "Edit here instead". That button requests the lock with `steal: true`. The tab losing the lock gets an `AbortError` on its lock promise (same spec). It flushes its autosave and becomes read-only.
- `BroadcastChannel` (Chrome 54, Firefox 38, Safari 15.4) tells the other tabs that a new version was written. Read-only tabs reload the model, and the Project list refreshes.

## 6. Failures

The rule is that the in-memory Project is the source of truth until a write succeeds. A failure never discards it.

| Failure | What happens | What the author sees |
|---|---|---|
| `QuotaExceededError` | IndexedDB aborts the transaction ([web.dev](https://web.dev/articles/storage-for-the-web); [MDN](https://developer.mozilla.org/en-US/docs/Web/API/Storage_API/Storage_quotas_and_eviction_criteria)), so nothing partial is stored. | A lasting banner: "Couldn't save: the browser's storage for this site is full." It offers **Export now**, **Free space** (trim old versions, remove unused assets) and **Show storage use**. Autosave retries after the next edit. |
| Other write failure, such as a closed connection or `UnknownError` | The transaction aborts. Retry once. | The same banner, worded "Couldn't save", with the error name under Details. |
| Storage unavailable, as in some private modes | `indexedDB.open` fails. | A banner on start: "This browser won't keep your work. Export before closing." Editing still works. |
| Evicted data | The Project list is empty or shorter. | The app can't tell this from a first visit. The export reminders are the defence. If the `projects` store lists a Project whose records have gone, the app says so. |
| Not a zip, or a truncated zip | The end record or central directory is missing, or a CRC check fails. | "This file isn't a complete Project file. It may have been cut off while downloading." Nothing is replaced. |
| `project.json` missing or invalid | `JSON.parse` fails, or validation reports a path. | "The Project inside this file is damaged at `pages[2].elements[5].left`." Validation collects every problem before reporting, like the Playground's field checks. |
| Newer `format` | See section 2. | "Made with a newer version." |
| Missing asset | The asset table names a hash with no matching file. | The Project opens. Each affected image shows a placeholder with the asset's name. A list names the missing assets and offers **Replace…**. Playing a missing sound is already a Script error ([#735](https://github.com/odogono/odgn-talk/issues/735#issuecomment-6142278126)). |
| Asset doesn't decode | The decode check fails. | Treated like a missing asset, with the reason. |

- **Importing never overwrites.** It always creates a new Project, even when the id matches one already stored, because the file may be an older copy. The app offers to replace the old Project only after the import succeeds, and then keeps the old one as a version.
- **Errors keep the browser's name.** Every failure keeps the `DOMException` name in a Details section, so a bug report carries it.

## 7. Saving to and opening from disk

### Export

- **Everywhere:** build the zip as a Blob, then click an `<a download="Title.ext">` whose `href` is from `URL.createObjectURL`. Revoke the URL afterwards.
- **Chrome and Edge also:** `showSaveFilePicker()` and `showOpenFilePicker()` are in Chrome 86, with no support in Firefox or Safari. MDN marks them experimental, and they need a user gesture ([MDN](https://developer.mozilla.org/en-US/docs/Web/API/Window/showSaveFilePicker)).
  - With a file handle, Save "writes the changes back to the original file". Handles can be kept in IndexedDB. Permission isn't always kept between sessions, so the app checks `queryPermission()` before writing and calls `requestPermission()` when needed ([Chrome for Developers](https://developer.chrome.com/docs/capabilities/web-apis/file-system-access)).
  - The write goes through `createWritable()`, so the file on disk is replaced only on `close()`.
- **Labels:** where the picker exists, offer **Save** (to the handle) and **Save As…**. Elsewhere, offer **Export…** only, so the label never promises an overwrite that a download can't do.

### Import

- **Everywhere:** `<input type="file">` and drag-and-drop onto the Project list. Chrome can also turn a drop into a handle through `DataTransferItem.getAsFileSystemHandle()` (Chrome for Developers, as above).
- **iOS needs a check.** Phones and tablets play Projects, so a recipient on iOS must be able to pick the file. That still needs testing on a device; see Open questions.
- **Sharing:** `navigator.share({files})` is in Safari 14 and Chromium, and behind a flag in Firefox. On a phone, it lets a reader pass a Project on, but it is not needed in v1.

### Opening from the operating system

- The manifest's `file_handlers`, with `launchQueue` receiving the files, is in desktop Chrome and Edge 102. It is not in Chrome on Android, Firefox or Safari. MDN marks it experimental and requires the app to be installed ([MDN](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Manifest/Reference/file_handlers)).
- It is a nice extra for Chromium desktop authors. It doesn't replace import.

## 8. Offline

- **A service worker caches the app shell.** Use Cache Storage for "the network resources necessary to load your app" ([web.dev, Storage for the web](https://web.dev/articles/storage-for-the-web)):
  - the HTML, scripts, CSS, fonts and the TS Core's files;
  - the LSP and session workers.

  The build emits a versioned list of these, and the service worker precaches it on install. Projects stay in IndexedDB and are never cached as responses.
- **Installing is not required by browsers, but it matters here.** MDN says a service worker is "not a requirement for a PWA to be installable" ([MDN, Making PWAs installable](https://developer.mozilla.org/en-US/docs/Web/Progressive_web_apps/Guides/Making_PWAs_installable)). But offline use needs one, and in Safari, installing is what exempts the app from the seven-day cap.
- **What each browser offers:**
  - Chromium desktop installs any site with a manifest that has `name`, 192 px and 512 px `icons`, `start_url` and `display`, served over HTTPS (same MDN page; [web.dev, install criteria](https://web.dev/articles/install-criteria)).
  - Safari 17 on macOS Sonoma offers File > Add to Dock for any site.
  - iOS 16.4 and later installs from the Share menu in Safari, Chrome, Edge and Firefox.
  - Firefox desktop doesn't install from a manifest (MDN). Firefox 143 on Windows can pin a site to the taskbar as a web app ([release notes](https://www.firefox.com/en-US/firefox/143.0/releasenotes/)).
- **Updates:**
  - A new service worker installs when its script is "byte-different". The browser checks on navigation, and long sessions can call `reg.update()` ([web.dev, service worker lifecycle](https://web.dev/articles/service-worker-lifecycle)).
  - The new worker waits until no tab uses the old one. Calling `skipWaiting()` early risks a page loaded by the old version being served by the new one (same article).
  - So the app shows "A new version is ready", flushes autosave, then sends `skipWaiting()` and reloads when the author clicks. It never skips automatically mid-edit.
  - A new version may raise the format, so its first run migrates autosaved Projects (section 2), keeping the old record as a version.

## Decisions

The maintainer settled these on #739:

- **Zip code:** we write our own small reader and writer, limited to methods 0 and 8, no encryption and no ZIP64. fflate stays the fallback if ours proves fragile.
- **Asset size limits:** warn above 10 MB for one asset and refuse above 50 MB, as in section 3. These are a judgement, not a sourced figure, so revisit them once the acceptance example's assets exist.
- **File extension:** it waits for the application's name, which is in #154's Fog. The media type could be registered in IANA's vendor tree later, but the app doesn't need that to work.
- **Stage 1 scope:** stage 1 includes a Project list and a panel for recovering earlier versions, besides autosave and export/import. Recovery is what makes autosave trustworthy for its audience.

## Open questions

These need testing on real devices, since no primary source documents them:

- **How iOS Safari treats a custom extension in `<input accept>`.** Recipients on phones depend on it. Test before choosing an `accept` value, and fall back to no `accept` filter on iOS if needed.
- **Which browsers play WAV.** MDN's compatibility tables don't cover it, which is why section 3 only accepts it with a warning.
