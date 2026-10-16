// The authoring Host interface from ADR 0084 and #735. Data only: Edit never
// constructs a Core Group or executes an authored Script.
import {
  coreVersions,
  parseSourceRecovering,
  syntaxSelector,
  type SyntaxNode,
} from '@odgn/northtalk';
import { ELEMENT_KINDS, type Element, type Page, type Project } from './model';

export type ScriptOwner = Project | Page | Element;

/** The Page containing an owner, absent for the Project Script. */
export const scriptPage = (
  project: Project,
  owner: ScriptOwner,
): Page | undefined =>
  project.pages.find(
    page => page === owner || page.elements.includes(owner as Element),
  );

const props = (fields: Record<string, string>) =>
  Object.entries(fields).map(([name, shape]) => ({
    name,
    shape,
    readOnly: name === 'name',
  }));
const common = {
  name: 'text',
  left: 'number',
  top: 'number',
  width: 'number',
  height: 'number',
  visible: 'boolean',
};
const specific: Record<Element['kind'], Record<string, string>> = {
  text: {
    text: 'text',
    textColor: 'text',
    textSize: 'number',
    font: 'text',
    editable: 'boolean',
  },
  image: { image: 'text' },
  button: { label: 'text', fill: 'text', textColor: 'text' },
  rectangle: { fill: 'text', stroke: 'text' },
  ellipse: { fill: 'text', stroke: 'text' },
  line: { stroke: 'text', thickness: 'number' },
};
const operation = (name: string, args: unknown[], result?: unknown) => ({
  name,
  args,
  mode: result === undefined ? 'fire-and-forget' : 'immediate',
  ...(result === undefined ? {} : { result }),
});

const suspending = (name: string, args: unknown[], result: unknown) => ({
  name,
  args,
  mode: 'suspending',
  result,
  maxPending: 2_147_483_647,
  errors: [{ code: 'user busy', fields: [] }],
});
// An Optional closed map whose every key is Optional.
const options = (fields: Record<string, string>) => ({
  optional: {
    map: Object.entries(fields).map(([key, shape]) => ({
      key,
      shape: { optional: shape },
      optional: true,
    })),
  },
});

// Shared by every Script's manifest.
const objectKinds = [
  { name: 'project', props: props({ name: 'text' }) },
  {
    name: 'page',
    props: props({ name: 'text', background: 'text', height: 'number' }),
  },
  ...ELEMENT_KINDS.map(name => ({
    name,
    props: props({ ...common, ...specific[name] }),
  })),
];
const grants = [
  {
    name: 'pages',
    capability: 'pages',
    operations: [operation('show', [{ object: 'page' }])],
  },
  {
    name: 'elements',
    capability: 'elements',
    operations: [
      operation(
        'create',
        ['text', { object: 'page' }, { optional: 'text' }],
        'object',
      ),
      operation('clone', ['object'], 'object'),
      operation('delete', ['object']),
      operation('find', ['text', { object: 'page' }], 'object'),
    ],
  },
  {
    name: 'sound',
    capability: 'sound',
    operations: [
      operation('play', ['text']),
      operation('loop', ['text']),
      operation('stop', [{ optional: 'text' }]),
    ],
  },
  {
    // Chapter 7's `user` Standard Capability, as the Play Session offers it.
    name: 'user',
    capability: 'user',
    operations: [
      suspending('confirm', ['text'], 'boolean'),
      suspending(
        'choose',
        [{ list: 'text' }, options({ prompt: 'text', multiple: 'boolean' })],
        { optional: { oneOf: ['text', { list: 'text' }] } },
      ),
      suspending('enter', ['text', options({ default: 'text' })], {
        optional: 'text',
      }),
      operation('notify', ['text', options({ title: 'text' })]),
    ],
  },
];
const messages = [
  'click',
  'pointerEnter',
  'pointerLeave',
  'keyDown',
  'openPage',
  'closePage',
  'startPlay',
  'textChanged',
].map(name => ({ name, args: name === 'keyDown' ? ['text'] : [] }));

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
export const scriptManifest = (project: Project, owner: ScriptOwner) => {
  const page = scriptPage(project, owner);
  if (owner !== project && !page) {
    throw new Error('The Script owner is not in this Project');
  }
  return {
    kind: 'kind' in owner ? owner.kind : owner === project ? 'project' : 'page',
    version: '1',
    language: coreVersions.language,
    libraries: [],
    objects: [
      ...project.pages.map(page => ({ name: page.name, kind: 'page' })),
      ...(page
        ? [
            ...page.elements.map(element => ({
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
