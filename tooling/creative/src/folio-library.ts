// The `folio` Library: HyperTalk-style commands for Folio's Objects, such as
// `hide welcomeText`. The Message Box imports it; an authored Script can
// with `use hide, show from folio`.
import { compileLibrary } from '@odgn/northtalk';
import { type Page, type Project } from './model';

export const FOLIO_LIBRARY_NAME = 'folio';

/** The Library's Handlers, in the order the Message Box imports them. */
export const FOLIO_COMMANDS = ['hide', 'show'] as const;

export const FOLIO_LIBRARY_SOURCE = `on hide target
  set the visible of target to false
end hide

on show target
  set the visible of target to true
end show
`;

export const folioLibrary = compileLibrary({
  name: FOLIO_LIBRARY_NAME,
  source: FOLIO_LIBRARY_SOURCE,
  version: '1',
});

/**
 * The lines around one Message Box command that make it a Script: an
 * import of the `folio` commands the Page's names leave free, then one
 * Handler. The command starts on line `MESSAGE_FIRST_LINE`.
 */
export const messageParts = (taken: ReadonlySet<string>) => {
  const commands = FOLIO_COMMANDS.filter(name => !taken.has(name));
  const use = commands.length
    ? `use ${commands.join(', ')} from ${FOLIO_LIBRARY_NAME}`
    : '';
  return { prefix: `${use}\non runMessage\n`, suffix: '\nend runMessage' };
};

export const messageSource = (command: string, taken: ReadonlySet<string>) => {
  const { prefix, suffix } = messageParts(taken);
  return prefix + command + suffix;
};

/** The names a Message Box command binds on `page`, which imports must not reuse. */
export const messageNames = (project: Project, page: Page): Set<string> =>
  new Set([
    ...project.pages.map(p => p.name),
    ...page.elements.map(e => e.name),
    'thisPage',
    'project',
  ]);

/** The line of the wrapped Script on which the command starts. */
export const MESSAGE_FIRST_LINE = 3;
