// The `folio` Library: HyperTalk-style commands for Folio's Objects, such as
// `hide welcomeText`. A Play Session also loads this source as the Script of
// a hidden object above the Project, so an unhandled `hide x` from any Script
// ends there, as HyperCard's built-in commands did; a Script can still answer
// `on hide` itself or `pass hide`. The ownerless Message Box imports it.
import { compileLibrary } from '@odgn/northtalk';
import { type Page, type Project } from './model';

export const FOLIO_LIBRARY_NAME = 'folio';

/** The Library's Handlers, in the order the Message Box imports them. */
export const FOLIO_COMMANDS = ['hide', 'show'] as const;

/**
 * The built-in commands as Script windows' language servers describe them:
 * Host Manifest messages, answered at the end of every Message Path.
 */
export const FOLIO_COMMAND_MESSAGES: {
  args: string[];
  description: string;
  examples: string[];
  name: (typeof FOLIO_COMMANDS)[number];
}[] = [
  {
    name: 'hide',
    args: ['object'],
    description:
      "Hides an Element: sets its visible to false. Built into Folio, so any Script can send it; a Script's own `on hide` answers first.",
    examples: ['hide welcomeText'],
  },
  {
    name: 'show',
    args: ['object'],
    description:
      "Shows an Element: sets its visible to true. Built into Folio, so any Script can send it; a Script's own `on show` answers first.",
    examples: ['show welcomeText'],
  },
];

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
