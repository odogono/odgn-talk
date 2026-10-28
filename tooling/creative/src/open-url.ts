/**
 * Opening a `.folio` file from any URL with `/folio/?open=<url>`
 * (ADR 0141, #1677). The host must serve the file with CORS. No DOM.
 */

/** The query parameter naming a `.folio` file to open. */
export const OPEN_PARAM = 'open';

/**
 * The URL a page address asks Folio to open, resolved against the
 * address, or `undefined` when it names none.
 */
export const openUrlOf = (address: string): string | undefined => {
  const page = new URL(address);
  const open = page.searchParams.get(OPEN_PARAM)?.trim();
  if (!open) {
    return undefined;
  }
  try {
    return new URL(open, page).href;
  } catch {
    return open;
  }
};

/** The page address without its `open` parameter. */
export const withoutOpenParam = (address: string): string => {
  const page = new URL(address);
  page.searchParams.delete(OPEN_PARAM);
  return page.href;
};

/** The file name a URL's last path segment gives, for the import. */
export const fileNameOf = (url: string): string => {
  try {
    const last = new URL(url).pathname.split('/').pop();
    return last ? decodeURIComponent(last) : 'project.folio';
  } catch {
    return 'project.folio';
  }
};

/**
 * Fetches a `.folio` file's bytes, throwing an error that says why in
 * the reader's terms: a bad address, a host that refused or can't be
 * reached (including one without CORS), or a file that isn't a `.folio`.
 */
export const fetchProjectFile = async (
  url: string,
  fetchFn: typeof fetch = fetch,
): Promise<Uint8Array> => {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`“${url}” isn't a web address.`);
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error(`“${url}” isn't an http or https address.`);
  }
  let response: Response;
  try {
    response = await fetchFn(parsed.href);
  } catch {
    throw new Error(
      `Couldn't reach ${parsed.host}. The address may be wrong, you may be offline, or the host doesn't allow other sites to read the file (CORS).`,
    );
  }
  if (!response.ok) {
    throw new Error(
      `${parsed.host} answered ${response.status}${response.statusText ? ` ${response.statusText}` : ''}.`,
    );
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  // A `.folio` file is a zip, so it starts with a local file header.
  if (
    bytes.length < 4 ||
    bytes[0] !== 0x50 ||
    bytes[1] !== 0x4b ||
    bytes[2] !== 0x03 ||
    bytes[3] !== 0x04
  ) {
    throw new Error(`The file at ${parsed.href} isn't a .folio file.`);
  }
  return bytes;
};
