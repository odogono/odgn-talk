// Copy as source (#1684): a value's source form onto the clipboard, from a
// Variables-window row or the Message Box's last result.

/** What a value without a source form says instead of copying. */
export const NO_SOURCE =
  'No source form: it holds a Function Value or Host Object.';

/** Copies `source`, returning what the button says it did. */
export const copySource = async (
  source: string | undefined,
): Promise<string> => {
  if (source === undefined) {
    return NO_SOURCE;
  }
  try {
    await navigator.clipboard.writeText(source);
    return 'Copied as source.';
  } catch {
    return 'Could not copy to the clipboard.';
  }
};
