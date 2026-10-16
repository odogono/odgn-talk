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
