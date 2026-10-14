# The creative tool is Folio, and Projects save as `.folio` files

The browser [creative tool](https://github.com/odogono/odgn-talk/issues/154) is named **Folio**. Its manifest uses `short_name` "Folio" and `name` "Folio, made with NorthTalk", and the page shows "Folio" with "made with NorthTalk" in a quieter place. Folio is a name of its own because its readers and authors are curious non-programmers: they should meet a friendly product, and they meet NorthTalk only when they open a Script. This follows [ADR 0039](0039-the-language-name-stands-apart-from-its-publisher.md), which kept the language name apart from its publisher. Here the application's name stands apart from the language.

Project files use the extension **`.folio`**, which comes from the name. The extension is hard to change once operating systems and installed apps associate it with Folio. The media type stays `application/vnd.odgn.northtalk-project+zip`, as chosen in [the storage research](../research/creative-tool-project-storage.md): it names the format, not the brand. Settled on [#818](https://github.com/odogono/odgn-talk/issues/818).

## Considered Options

- **"NorthTalk Studio" or plain "NorthTalk".** These tie the application to the language. "Studio" reads as a developer tool, and plain "NorthTalk" blurs the language with one of its Hosts.
- **An extension named for the format, such as `.ntproj`.** It would survive a rename of the application, but authors would find it harder to recognise. Import ignores the extension, so a later rename costs less than the extension being unclear now.
- **Keep `.zip`.** The operating system would open a Project in an archive tool instead of Folio.
- **`.talk`.** It already belongs to Script source files.

## Consequences

- Folio names the application only. The authored creation is still a Project, saved as a Project file. The glossary lists "folio" as a word to avoid for either.
- The internal ids keep their earlier names: the `app` value `northtalk-creative` in `project.json`, the `@odgn/northtalk-creative` package and the `tooling/creative` folder. The `mimetype` entry and the Blob type keep the media type. Renaming any of them would change the file format or the build, and users would gain nothing.
- Import checks a file's content, not its name. Files exported as `.zip` before the application was named keep opening, with no `format` bump and no migration.
- Registering the media type and `.folio` for opening files from the operating system waits for offline use and installation in [#823](https://github.com/odogono/odgn-talk/issues/823). Whether iOS Safari's file picker accepts a custom extension is still a device check, so import keeps no `accept` filter.
