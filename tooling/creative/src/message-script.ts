// The Script one Message Box command runs as: one Handler around the
// command. `hide` and `show` need no import, since they are Host Commands of
// the `folio` Grant every Message Box command gets (ADR 0094).

const PREFIX = 'on runMessage\n';
const SUFFIX = '\nend runMessage';

/** The lines around one Message Box command that make it a Script. */
export const messageParts = () => ({ prefix: PREFIX, suffix: SUFFIX });

export const messageSource = (command: string) => PREFIX + command + SUFFIX;

/** The line of the wrapped Script on which the command starts. */
export const MESSAGE_FIRST_LINE = 2;

/** A loaded Script's immutable editor context, identified within its Play Session. */
export type LoadedMessageTarget = {
  id: number;
  label: string;
  manifest: ReturnType<typeof import('./script-manifest').scriptManifest>;
  source: string;
};

export const MESSAGE_HANDLER_LIMIT = 1000;

/** A collision-free wrapper name, also used by the editor's hidden wrapper. */
export const messageHandler = (source: string, start = 1): string => {
  let n = start;
  while (source.includes(`folioMessage${n}`)) {
    n++;
  }
  return `folioMessage${n}`;
};
