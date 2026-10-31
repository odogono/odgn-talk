// The stdlib Libraries this process carries. The `@northtalk/ts` entry
// registers all seven; a Host on `@northtalk/ts/lean` registers the ones it
// wants, so a bundler can drop the rest (#1856). A Library its source's `use`
// lines name comes with it.
import { libraryExports } from './generated/syntax';

/** A stdlib Library's normative source, from `@northtalk/ts/stdlib/<name>`. */
export type StdlibLibrary = {
  readonly name: string;
  /** The stdlib Libraries its `use` lines name. */
  readonly requires: readonly StdlibLibrary[];
  readonly source: string;
};

/** The seven stdlib Library names, which a Host may not register. */
export const stdlibNames: ReadonlySet<string> = new Set(
  libraryExports.map(entry => entry.library),
);

const registered = new Map<string, string>();
const names = new Set<string>();
/** The registered stdlib Library names. */
export const registeredStdlib: ReadonlySet<string> = names;

/**
 * Make stdlib Libraries available to every Group in the process, with the
 * stdlib Libraries they import. Registering one twice does nothing.
 */
export const registerStdlib = (
  ...libraries: readonly StdlibLibrary[]
): void => {
  for (const l of libraries) {
    if (!stdlibNames.has(l.name)) {
      throw new TypeError(`${l.name} isn't a stdlib Library`);
    }
    if (!registered.has(l.name)) {
      registered.set(l.name, l.source);
      names.add(l.name);
      registerStdlib(...l.requires);
    }
  }
};

/** A registered stdlib Library's source. */
export const stdlibSource = (name: string): string | undefined =>
  registered.get(name);
