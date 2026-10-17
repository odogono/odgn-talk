import { type Immutable } from 'immer';
import { grammar } from '@odgn/northtalk';
import { isIdentifierName, type Page, type Project } from './model';
import type { ScriptOwner } from './script-manifest';

export const reservedScriptNames: ReadonlySet<string> = new Set([
  ...grammar.reserved,
  '_',
  'thisPage',
  'project',
  'pages',
  'elements',
  'sound',
]);
export const elementNamesTaken = (
  project: Immutable<Project>,
  page: Immutable<Page>,
  current?: string,
): Set<string> =>
  new Set([
    ...reservedScriptNames,
    ...project.pages.map(p => p.name),
    ...page.elements.filter(e => e.name !== current).map(e => e.name),
  ]);
export const pageNamesTaken = (
  project: Immutable<Project>,
  current?: string,
): Set<string> =>
  new Set([
    ...reservedScriptNames,
    ...project.pages.filter(p => p.name !== current).map(p => p.name),
    ...project.pages.flatMap(p => p.elements.map(e => e.name)),
  ]);

/** Imported Projects remain untouched; identify each owner requiring repair. */
export const scriptNameProblems = (
  project: Immutable<Project>,
): { message: string; owner: ScriptOwner }[] => {
  const problems: { message: string; owner: ScriptOwner }[] = [];
  const check = (owner: ScriptOwner, label: string, collision: boolean) => {
    const reason =
      !isIdentifierName(owner.name) || reservedScriptNames.has(owner.name)
        ? 'is not an available Script identifier'
        : collision
          ? 'conflicts with another Page or Element name'
          : undefined;
    if (reason) {
      problems.push({
        owner,
        message: `${label} “${owner.name}” ${reason}. Rename it in Info before Play or adding an action.`,
      });
    }
  };
  for (const page of project.pages) {
    check(
      page,
      'Page',
      project.pages.some(other => other !== page && other.name === page.name) ||
        project.pages.some(p => p.elements.some(e => e.name === page.name)),
    );
    for (const element of page.elements) {
      check(
        element,
        `Element on ${page.name}`,
        project.pages.some(p => p.name === element.name) ||
          page.elements.some(
            other => other !== element && other.name === element.name,
          ),
      );
    }
  }
  return problems;
};
