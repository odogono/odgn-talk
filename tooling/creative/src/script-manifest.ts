import type { DeepReadonly } from './readonly';
import { allElements } from './tree/rules';
import { propertiesForKind } from './tree/properties';
// The authoring Host interface from ADR 0084 and #735. Data only: Edit never
// constructs a Core Group or executes an authored Script.
import {
  coreVersions,
  parseSourceRecovering,
  syntaxSelector,
  type SyntaxNode,
} from '@northtalk/ts';
import { manifestGrants } from './grants';
import { PUMP_FUEL } from './grants/elements';
import type { WorkspaceConfiguration } from '@northtalk/tooling/lsp';
import { ELEMENT_KINDS, type Element, type Page, type Project } from './model';

export type ScriptOwner = DeepReadonly<Project | Page | Element>;

/** An owner's session id; the Project Script is 0. */
export const ownerId = (owner: ScriptOwner): number =>
  'pages' in owner ? 0 : owner.id!;

/** Every Script owner: the Project, then each Page followed by its Elements. */
export const scriptOwners = <P extends DeepReadonly<Project> | Project>(
  project: P,
): (P | P['pages'][number] | P['pages'][number]['elements'][number])[] => [
  project,
  ...project.pages.flatMap(page => [page, ...allElements(page.elements)]),
];

/** The owner with a session id, absent once it has gone. */
export const ownerById = <P extends DeepReadonly<Project> | Project>(
  project: P,
  id: number,
) => scriptOwners(project).find(owner => ownerId(owner) === id);

/** The Page containing an owner, absent for the Project Script. */
export const scriptPage = (
  project: DeepReadonly<Project>,
  owner: ScriptOwner,
): DeepReadonly<Page> | undefined =>
  project.pages.find(
    page =>
      page === owner ||
      allElements(page.elements).includes(owner as DeepReadonly<Element>),
  );

type ManifestProperty = {
  name: string;
  readOnly: boolean;
  setCost?: { fuel: number };
  shape: string;
};
const props = (kind: string): ManifestProperty[] =>
  [...propertiesForKind(kind)]
    .filter(([, descriptor]) => descriptor.script !== false)
    .map(([name, descriptor]) => ({
      name,
      shape: descriptor.shape,
      readOnly: !descriptor.set,
      ...(descriptor.setCost ? { setCost: descriptor.setCost } : {}),
    }));
// Any Element, as a Page or Group's members are.
const elementShape = { oneOf: ELEMENT_KINDS.map(kind => ({ object: kind })) };

// Shared by every Script's manifest.
const objectKinds = [
  { name: 'project', props: props('project') },
  {
    name: 'page',
    props: props('page'),
    // Play's Page Object Collection (#1143), as data.
    elements: {
      shape: elementShape,
      countCost: { fuel: 1, alloc: 0 },
      atCost: { fuel: 1, alloc: 0 },
      findCost: { fuel: 1, alloc: 0 },
    },
  },
  ...ELEMENT_KINDS.map(name => ({
    name,
    props: props(name),
    ...(name === 'group'
      ? {
          elements: {
            shape: elementShape,
            countCost: { fuel: 1, alloc: 0 },
            atCost: { fuel: 1, alloc: 0 },
            findCost: { fuel: 1, alloc: 0 },
          },
        }
      : {}),
  })),
];
// Each Grant's entry, derived from its definition (#1453).
const grants = manifestGrants();
const messages = [
  'click',
  'pointerEnter',
  'pointerLeave',
  'keyDown',
  'keyUp',
  'openPage',
  'closePage',
  'startPlay',
  'textChanged',
].map(name => ({
  name,
  args: name === 'keyDown' || name === 'keyUp' ? ['text'] : [],
}));

// Folio also delivers messages authored Scripts send to each other. Declare
// an owner's named Handlers alongside the built-in events; the Host event
// list alone would incorrectly flag custom Handlers as unknown messages.
const scriptMessages = (source: string) => {
  const declared = new Map(messages.map(message => [message.name, message]));
  const nodes: SyntaxNode[] = [parseSourceRecovering(source).tree];
  while (nodes.length) {
    const node = nodes.pop()!;
    if (node.rule === 'Handler') {
      const message = node.children.find(
        child => child.kind === 'node' && child.rule === 'MessageName',
      );
      if (message?.kind === 'node') {
        const name = syntaxSelector(
          node,
          source.slice(message.start, message.end).trim(),
        );
        const arity = node.children.filter(
          child => child.kind === 'node' && child.rule === 'Pattern',
        ).length;
        if (!declared.has(name)) {
          declared.set(name, {
            name,
            args: Array<string>(arity).fill('value'),
          });
        }
      }
    } else if (node.rule !== 'Error') {
      nodes.push(
        ...node.children.filter(
          (child): child is SyntaxNode => child.kind === 'node',
        ),
      );
    }
  }
  return [...declared.values()];
};

/** Every Script binds all Pages and only its own Page's Elements. */
export const scriptManifest = (
  project: DeepReadonly<Project>,
  owner: ScriptOwner,
) => {
  const page = scriptPage(project, owner);
  if (owner !== project && !page) {
    throw new Error('The Script owner is not in this Project');
  }
  return {
    kind: 'kind' in owner ? owner.kind : owner === project ? 'project' : 'page',
    version: '1',
    language: coreVersions.language,
    libraries: project.libraries.map(({ name, source }) => ({ name, source })),
    objects: [
      ...project.pages.map(page => ({ name: page.name, kind: 'page' })),
      ...(page
        ? [
            ...allElements(page.elements).map(element => ({
              name: element.name,
              kind: element.kind,
            })),
            { name: 'thisPage', kind: 'page' },
            { name: 'project', kind: 'project' },
          ]
        : []),
    ],
    objectKinds,
    grants,
    messages: scriptMessages(owner.script ?? ''),
  };
};

/**
 * Folio's language-server configuration: the Manifest, the sources, and the
 * Fuel each Pump spends per frame, so a Fuel Bound over one frame says so.
 */
export const languageConfiguration = (
  manifest: ReturnType<typeof scriptManifest>,
  sources?: WorkspaceConfiguration['sources'],
): WorkspaceConfiguration => ({
  manifest,
  ...(sources ? { sources } : {}),
  fuelFrame: PUMP_FUEL,
});
