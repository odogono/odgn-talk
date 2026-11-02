// The Add-ons built with Folio (ADR 0162, #1901). Each is a separate chunk at
// `add-ons/<slug>-<version>.js`, fetched the first time a Project or author
// needs it and kept by the service worker. #1902 adds the first.

export type CatalogueEntry = {
  /** The Add-on's URL. */
  id: string;
  /** Its kinds as the Tools window lists them before it loads. */
  kinds: readonly { icon: string; label: string; name: string }[];
  /** Its source under `src/add-ons/`, and its chunk's name. */
  slug: string;
  version: string;
};

export const BUILT_IN_ADD_ONS: readonly CatalogueEntry[] = [];

/** The chunk a built-in Add-on is served as, relative to Folio. */
export const addOnChunk = (entry: CatalogueEntry): string =>
  `add-ons/${entry.slug}-${entry.version}.js`;
