import { thaw } from '../src/readonly';
import { expect, spyOn, test } from 'bun:test';
import { createElement, createProject, type Element } from '../src/model';
import { allElements, groupElement, refreshBounds } from '../src/tree/rules';
import { ProjectTree, type TreeJournal } from '../src/tree/project-tree';

const fixture = () => {
  const project = createProject('Tree');
  project.pages[0]!.elements = [
    createElement('button', 'a'),
    groupElement('panel', [
      createElement('button', 'b'),
      groupElement('inner', [createElement('text', 'entry')]),
    ]),
  ];
  return project;
};
const check = (tree: ProjectTree) => {
  for (const page of tree.project.pages) {
    expect(tree.elementsOf(page)).toEqual(allElements(page.elements));
    const copy = thaw<Element[]>(page.elements);
    refreshBounds(copy);
    expect(page.elements).toEqual(copy);
    for (const element of tree.elementsOf(page)) {
      expect(tree.find(page, element.name)).toBe(element);
      expect(tree.pageOf(element)).toBe(page);
      expect(tree.membersOf(tree.parentOf(element)!)).toContain(element);
    }
  }
};

test('mixed structural mutations maintain indexed views, bounds and identities', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const original = tree.find(page, 'b')!;
  const clone = tree.clone(tree.find(page, 'inner')!);
  check(tree);
  tree.create('ellipse', page, 'new');
  tree.clone(original);
  check(tree);
  tree.reorder(page, [...page.elements].reverse());
  check(tree);
  expect(tree.find(page, 'b')).toBe(original);
  tree.remove(clone.root);
  tree.remove(tree.find(page, 'entry')!);
  check(tree);
  const inner = tree.find(page, 'inner')!;
  expect(inner).toMatchObject({ kind: 'group', width: 0, height: 0 });
  expect(tree.contains(clone.root)).toBe(false);
});

test('new subtrees are authorized and installed before publication; hooks cannot reenter', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const order: string[] = [];
  const result = tree.clone(tree.find(page, 'panel')!, {
    authorize: fuel => {
      expect(fuel).toBeGreaterThan(0);
      order.push('authorize');
    },
    install: (root, parent) => {
      order.push('install');
      expect(parent).toBe(page);
      expect(tree.contains(root)).toBe(false);
      expect(tree.find(page, root.name)).toBeUndefined();
      expect(() => tree.create('button', page)).toThrow('reenter');
    },
  });
  expect(order).toEqual(['authorize', 'install']);
  expect(tree.find(page, result.root.name)).toBe(result.root);
  check(tree);
});

test('authorization refusal happens before expensive copies and publishes no effects', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const before = tree.snapshot();
  let events = 0;
  tree.subscribe(() => events++);
  const clone = spyOn(globalThis, 'structuredClone');
  try {
    expect(() =>
      tree.clone(tree.find(page, 'panel')!, {
        authorize: () => {
          throw new Error('refused');
        },
        install: () => {
          throw new Error('must not install');
        },
      }),
    ).toThrow('refused');
    expect(clone).not.toHaveBeenCalled();
  } finally {
    clone.mockRestore();
  }
  expect(events).toBe(0);
  expect(tree.project).toEqual(before);
});

test('failed compound updates roll back properties, membership and caches without notification', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const entry = tree.find(page, 'entry')!;
  if (entry.kind !== 'text') {
    throw new Error('fixture');
  }
  const richText = entry.richText;
  const members = page.elements;
  const before = tree.snapshot();
  const costs: number[] = [];
  tree.clone(entry, { authorize: fuel => costs.push(fuel) });
  tree.remove(tree.find(page, 'entry2')!);
  let events = 0;
  tree.subscribe(() => events++);
  expect(() =>
    tree.transaction(() => {
      tree.setProperty(tree.find(page, 'b')!, 'label', 'changed');
      tree.remove(entry);
      tree.create('button', page, 'temporary');
      throw new Error('abort');
    }),
  ).toThrow('abort');
  expect(tree.project).toEqual(before);
  expect(tree.find(page, 'entry')).toBe(entry);
  expect(page.elements).toBe(members);
  if (entry.kind === 'text') {
    expect(entry.richText).toBe(richText);
  }
  expect(events).toBe(0);
  check(tree);
  tree.clone(tree.find(page, 'entry')!, {
    authorize: fuel => costs.push(fuel),
  });
  expect(costs[1]).toBe(costs[0]);
});

test('history restores detached subtrees without drift across later edits', () => {
  let nextId = 0;
  const tree = new ProjectTree(fixture(), () => ++nextId);
  const page = tree.project.pages[0]!;
  const original = tree.snapshot();
  const changes: TreeJournal[] = [];
  const unsubscribe = tree.subscribe(event => changes.push(event.changes));
  tree.remove(tree.find(page, 'panel')!);
  unsubscribe();
  const deletion = changes[0]!;
  for (let i = 0; i < 3; i++) {
    tree.replay(deletion, false);
    expect(tree.project).toEqual(original);
    tree.setProperty(tree.find(page, 'b')!, 'label', `new ${i}`);
    tree.replay(deletion, true);
  }
  tree.replay(deletion, false);
  expect(tree.project).toEqual(original);
  check(tree);
});

test('reorder rejects foreign, duplicate and missing members atomically', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const before = tree.snapshot();
  for (const order of [
    [],
    [page.elements[0]!, page.elements[0]!],
    [page.elements[0]!, createElement('button', 'foreign')],
  ]) {
    expect(() => tree.reorder(page, order)).toThrow('permutation');
    expect(tree.project).toEqual(before);
  }
});

test('rich text input is detached and clone work reflects reader growth', () => {
  const project = fixture();
  const tree = new ProjectTree(project);
  const page = tree.project.pages[0]!;
  const entry = tree.find(page, 'entry')!;
  if (entry.kind !== 'text') {
    throw new Error('fixture');
  }
  const costs: number[] = [];
  tree.clone(entry, { authorize: fuel => costs.push(fuel) });
  tree.remove(tree.find(page, 'entry2')!);
  const value = [{ runs: [{ text: 'x'.repeat(20_000) }] }];
  tree.replaceRichText(entry, value);
  value[0]!.runs[0]!.text = 'caller mutation';
  expect(entry.richText[0]!.runs[0]!.text.length).toBe(20_000);
  tree.clone(entry, { authorize: fuel => costs.push(fuel) });
  expect(costs[1]!).toBeGreaterThan(costs[0]! + 20_000);
  expect(project).toEqual(fixture());
});

test('net-zero field and structural changes are recognized without whole-Project snapshots', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const keys = tree.historyKeys();
  const changes: TreeJournal[] = [];
  tree.subscribe(event => changes.push(event.changes));
  tree.setProperty(tree.find(page, 'b')!, 'label', 'different');
  tree.setProperty(tree.find(page, 'b')!, 'label', 'Button');
  const temporary = tree.create('button', page);
  tree.setProperty(temporary, 'label', 'temporary edit');
  tree.remove(temporary);
  expect(tree.isNetZero(changes.flat(), keys)).toBe(true);
});

test('Edit intake accepts conflicting names so owners can be repaired by id', () => {
  const project = fixture();
  project.pages[0]!.elements.push(createElement('button', 'b'));
  let id = 0;
  const tree = new ProjectTree(project, () => ++id);
  const b = tree
    .elementsOf(tree.project.pages[0]!)
    .filter(element => element.name === 'b');
  expect(b).toHaveLength(2);
  tree.rename(tree.owner(b[1]!.id!)! as (typeof b)[number], 'repaired');
  expect(tree.find(tree.project.pages[0]!, 'repaired')).toBe(b[1]);
});

test('ungrouping an empty nested group refreshes its parent bounds and replays cleanly', () => {
  const project = fixture();
  const empty = groupElement('empty', []);
  empty.left = 1000;
  project.pages[0]!.elements = [
    groupElement('outer', [empty, createElement('button', 'button')]),
  ];
  const tree = new ProjectTree(project);
  const before = tree.snapshot();
  const page = tree.project.pages[0]!;
  const group = tree.find(page, 'empty')!;
  if (group.kind !== 'group') {
    throw new Error('fixture');
  }
  let changes: TreeJournal = [];
  const unsubscribe = tree.subscribe(event => {
    changes = event.changes;
  });
  tree.ungroup(group);
  unsubscribe();
  check(tree);
  expect(tree.find(page, 'outer')!.width).toBe(200);
  tree.replay(changes, false);
  expect(tree.project).toEqual(before);
});

test('async installation hooks are rejected before tree publication', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const before = tree.snapshot();
  expect(() =>
    tree.create('button', page, 'asyncButton', { install: async () => {} }),
  ).toThrow('synchronously');
  expect(tree.project).toEqual(before);
  expect(tree.find(page, 'asyncButton')).toBeUndefined();
});

test('Play geometry and scalar writes never serialize unrelated rich text', () => {
  const tree = new ProjectTree(fixture(), undefined, false);
  const page = tree.project.pages[0]!;
  const entry = tree.find(page, 'entry')!;
  if (entry.kind !== 'text') {
    throw new Error('fixture');
  }
  tree.replaceRichText(entry, [{ runs: [{ text: 'large'.repeat(20_000) }] }]);
  const stringify = spyOn(JSON, 'stringify');
  try {
    tree.setGeometry(tree.find(page, 'panel')!, { left: 400 });
    tree.setProperty(entry, 'visible', false);
    tree.setProperty(entry, 'textSize', 20);
    expect(
      stringify.mock.calls.some(([value]) => value === entry.richText),
    ).toBe(false);
  } finally {
    stringify.mockRestore();
  }
});

test('structural change records identify removed descendants and their Page', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const panel = tree.find(page, 'panel')!;
  const removed = allElements([panel]);
  let affected: readonly unknown[] = [];
  let pages: readonly unknown[] = [];
  tree.subscribe(event => {
    affected = event.owners;
    pages = event.pages;
  });
  tree.remove(panel);
  for (const owner of removed) {
    expect(affected).toContain(owner);
  }
  expect(pages).toContain(page);
});

test('snapshots and history freeze detached data while live owners remain mutable', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const entry = tree.find(page, 'entry')!;
  const snapshot = tree.snapshot();
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.pages[0]!.elements)).toBe(true);
  let journal: TreeJournal = [];
  const unsubscribe = tree.subscribe(change => {
    journal = change.changes;
  });
  tree.setProperty(entry, 'text', 'changed');
  unsubscribe();
  const change = journal.find(
    change => change.kind === 'field' && change.field === 'richText',
  )!;
  expect(Object.isFrozen(journal)).toBe(true);
  expect(Object.isFrozen(change)).toBe(true);
  if (change.kind !== 'field') {
    throw new Error('expected rich text change');
  }
  expect(Object.isFrozen(change.after)).toBe(true);
  expect(
    Object.isFrozen((change.after as { runs: unknown[] }[])[0]!.runs[0]),
  ).toBe(true);
  expect(Object.isFrozen(entry)).toBe(false);
  tree.setProperty(entry, 'text', 'later');
  tree.replay(journal, false);
  expect(tree.snapshot()).toEqual(snapshot);
});

test('property writes preserve rich text alignment, group bounds and reversible history', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const entry = tree.find(page, 'entry')!;
  if (entry.kind !== 'text') {
    throw new Error('fixture');
  }
  tree.replaceRichText(entry, [
    { align: 'right', runs: [{ bold: true, text: 'Original' }] },
  ]);
  const before = tree.snapshot();
  let changes: TreeJournal = [];
  const unsubscribe = tree.subscribe(event => {
    changes = event.changes;
  });
  tree.transaction(() => {
    tree.setProperty(entry, 'textAlign', 'center');
    tree.setProperty(entry, 'text', 'One\r\nTwo');
    tree.setProperty(entry, 'left', 700);
    tree.setProperty(page, 'background', '#123456');
    tree.setProperty(tree.project, 'designWidth', 900);
  });
  unsubscribe();
  expect(entry.richText).toEqual([
    { align: 'center', runs: [{ text: 'One' }] },
    { align: 'center', runs: [{ text: 'Two' }] },
  ]);
  expect(tree.find(page, 'inner')!.left).toBe(700);
  expect(tree.project.designWidth).toBe(900);
  expect(page.background).toBe('#123456');
  check(tree);
  const after = tree.snapshot();
  tree.replay(changes, false);
  expect(tree.project).toEqual(before);
  tree.replay(changes, true);
  expect(tree.project).toEqual(after);
  check(tree);
});

test('invalid and dedicated property writes leave the tree and indexes unchanged', () => {
  const tree = new ProjectTree(fixture());
  const page = tree.project.pages[0]!;
  const entry = tree.find(page, 'entry')!;
  const border = tree.create('rectangle', page);
  const before = tree.snapshot();
  let events = 0;
  tree.subscribe(() => events++);
  for (const [owner, field, value] of [
    [entry, 'textAlign', 'middle'],
    [entry, 'textSize', Infinity],
    [entry, 'left', Number.NaN],
    [border, 'thickness', -1],
    [tree.find(page, 'panel')!, 'width', 10],
    [entry, 'name', 'renamed'],
    [entry, 'richText', 'replacement'],
    [entry, 'members', 'replacement'],
    [entry, 'label', 'wrong kind'],
    [entry, 'constructor', 'unknown'],
    [entry, '__proto__', 'unknown'],
  ] as const) {
    expect(() => tree.setProperty(owner, field, value)).toThrow();
    expect(tree.project).toEqual(before);
  }
  expect(events).toBe(0);
  check(tree);
});
