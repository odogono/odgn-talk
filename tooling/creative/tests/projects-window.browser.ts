// Dedicated page without main.js; mounts the Projects window lists into the
// page's own <ul>s with signals standing in for storage and the edit lock.
import { signal } from '@preact/signals';
import type { ExampleProject } from '../src/examples';
import {
  mountProjectsWindow,
  type ProjectsWindowActions,
} from '../src/projects-window';
import type { ProjectRecord, VersionInfo } from '../src/storage';

const equal = (actual: unknown, expected: unknown) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(
      `Expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
};

const same = (actual: unknown, expected: unknown, what: string) => {
  if (actual !== expected) {
    throw new Error(`${what} was replaced`);
  }
};

const settle = () => new Promise(resolve => setTimeout(resolve, 20));

const record = (id: string, title: string): ProjectRecord => ({
  format: 1,
  id,
  modifiedAt: 0,
  seq: 1,
  title,
});

const buttons = (li: Element | null | undefined) =>
  [...(li?.querySelectorAll('button') ?? [])].map(button => [
    button.textContent,
    button.disabled,
  ]);

const mount = (stored = true) => {
  const calls: unknown[][] = [];
  const state = {
    confirmingDeleteId: signal<string | undefined>(undefined),
    currentId: signal('a'),
    editing: signal(true),
    orphaned: signal(false),
    previewSeq: signal<number | undefined>(undefined),
    records: signal<readonly ProjectRecord[]>([
      record('a', 'Alpha'),
      record('b', 'Beta'),
    ]),
    renamingId: signal<string | undefined>(undefined),
    stored,
    versions: signal<readonly VersionInfo[]>([
      { seq: 3, savedAt: 0, pageCount: 2 },
      { seq: 2, savedAt: 0, pageCount: 1 },
    ]),
  };
  const log =
    (name: string) =>
    (...args: unknown[]) =>
      calls.push([name, ...args]);
  const actions: ProjectsWindowActions = {
    backToLatest: log('backToLatest'),
    // As projects.ts does: one row at a time is renaming or confirming.
    cancel: () => {
      state.renamingId.value = undefined;
      state.confirmingDeleteId.value = undefined;
    },
    confirmDelete: id => {
      state.confirmingDeleteId.value = id;
      state.renamingId.value = undefined;
    },
    delete: log('delete'),
    duplicate: log('duplicate'),
    open: log('open'),
    openExample: example => calls.push(['openExample', example.name]),
    previewVersion: version => calls.push(['previewVersion', version.seq]),
    rename: log('rename'),
    startRename: id => {
      state.renamingId.value = id;
      state.confirmingDeleteId.value = undefined;
    },
  };
  const examples: ExampleProject[] = [
    {
      name: 'Sample',
      description: 'A sample.',
      create: () => Promise.reject(new Error('unused')),
    },
  ];
  const projects = document.querySelector<HTMLElement>('#project-list')!;
  const versions = document.querySelector<HTMLElement>('#version-list')!;
  // Shown, as the lists are when the author uses them: hidden fields can't
  // take focus.
  const windows = ['#projects-window', '#versions-window'].map(selector =>
    document.querySelector<HTMLElement>(selector)!,
  );
  for (const win of windows) {
    win.hidden = false;
  }
  const unmountLists = mountProjectsWindow(
    {
      examples: document.querySelector<HTMLElement>('#example-list')!,
      projects,
      versions,
    },
    { actions, examples, state },
  );
  const unmount = () => {
    unmountLists();
    for (const win of windows) {
      win.hidden = true;
    }
  };
  return { actions, calls, projects, state, unmount, versions };
};

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };

  await test('the Project list draws rows, buttons and the lock', async () => {
    const { projects, state, unmount } = mount();
    try {
      await settle();
      const [alpha, beta] = projects.querySelectorAll('li');
      equal(
        alpha!.querySelector('.title.current')?.firstChild?.textContent,
        'Alpha ',
      );
      equal(buttons(alpha), [
        ['Rename', false],
        ['Duplicate', false],
        ['Delete', false],
      ]);
      equal(buttons(beta), [
        ['Open', false],
        ['Rename', false],
        ['Duplicate', false],
        ['Delete', false],
      ]);
      state.editing.value = false;
      await settle();
      equal(buttons(projects.querySelector('li')), [
        ['Rename', true],
        ['Duplicate', false],
        ['Delete', true],
      ]);
      same(projects.querySelectorAll('li')[0], alpha, 'The current row');
    } finally {
      unmount();
    }
  });

  await test('a rename field keeps focus and typed text while the list redraws', async () => {
    const { calls, projects, state, unmount } = mount();
    try {
      await settle();
      const beta = projects.querySelectorAll('li')[1]!;
      [...beta.querySelectorAll('button')]
        .find(button => button.textContent === 'Rename')!
        .click();
      await settle();
      const input = beta.querySelector<HTMLInputElement>(
        'input[aria-label="Project name"]',
      )!;
      equal(input.value, 'Beta');
      input.focus();
      input.value = 'Beta draft';
      input.setSelectionRange(2, 4);
      // Another tab saves and renames: the list reloads and the lock moves.
      state.records.value = [
        record('c', 'Gamma'),
        record('a', 'Alpha'),
        record('b', 'Beta elsewhere'),
      ];
      state.editing.value = false;
      state.currentId.value = 'c';
      await settle();
      const still = projects.querySelector<HTMLInputElement>('input')!;
      same(still, input, 'The rename field');
      same(document.activeElement, input, 'The focused field');
      equal(input.value, 'Beta draft');
      equal([input.selectionStart, input.selectionEnd], [2, 4]);
      equal(buttons(input.parentElement), [
        ['Save', false],
        ['Cancel', false],
      ]);
      [...input.parentElement!.querySelectorAll('button')]
        .find(button => button.textContent === 'Save')!
        .click();
      equal(calls, [['rename', 'b', 'Beta draft']]);
      [...input.parentElement!.querySelectorAll('button')]
        .find(button => button.textContent === 'Cancel')!
        .click();
      await settle();
      equal(projects.querySelector('input'), null);
    } finally {
      unmount();
    }
  });

  await test('Delete asks first, and Keep puts it back', async () => {
    const { calls, projects, state, unmount } = mount();
    try {
      await settle();
      const beta = projects.querySelectorAll('li')[1]!;
      const click = (text: string) =>
        [...beta.querySelectorAll('button')]
          .find(button => button.textContent === text)!
          .click();
      click('Delete');
      await settle();
      equal(state.confirmingDeleteId.value, 'b');
      equal(
        buttons(beta).map(([text]) => text),
        ['Open', 'Rename', 'Duplicate', 'Delete this Project?', 'Keep'],
      );
      click('Keep');
      await settle();
      equal(state.confirmingDeleteId.value, undefined);
      click('Delete');
      await settle();
      click('Delete this Project?');
      click('Duplicate');
      click('Open');
      equal(calls, [
        ['delete', 'b'],
        ['duplicate', 'b'],
        ['open', 'b'],
      ]);
    } finally {
      unmount();
    }
  });

  await test('the version list follows the previewed version in place', async () => {
    const { calls, state, unmount, versions } = mount();
    try {
      await settle();
      const [latest, earlier] = versions.querySelectorAll('li');
      equal(latest!.querySelector('.muted')?.textContent, '2 Pages · latest');
      equal(earlier!.querySelector('.muted')?.textContent, '1 Page');
      equal(buttons(latest), [['Preview', true]]);
      equal(buttons(earlier), [['Preview', false]]);
      earlier!.querySelector('button')!.click();
      equal(calls, [['previewVersion', 2]]);
      state.previewSeq.value = 2;
      await settle();
      same(versions.querySelectorAll('li')[1], earlier, 'The version row');
      equal(buttons(latest), [['Preview', false]]);
      equal(buttons(earlier), [['Viewing', true]]);
      latest!.querySelector('button')!.click();
      equal(calls.at(-1), ['backToLatest']);
      state.orphaned.value = true;
      await settle();
      equal(versions.textContent, 'No earlier versions are kept.');
    } finally {
      unmount();
    }
  });

  await test('Example Projects and the no-storage messages', async () => {
    const { calls, projects, unmount, versions } = mount(false);
    try {
      await settle();
      equal(projects.textContent, "Projects can't be kept in this browser.");
      equal(versions.textContent, 'No earlier versions are kept.');
      const open = document.querySelector<HTMLButtonElement>(
        '#example-list [data-example="Sample"]',
      )!;
      equal(open.textContent, 'Open Sample');
      equal(open.nextElementSibling?.textContent, 'A sample.');
      open.click();
      equal(calls, [['openExample', 'Sample']]);
    } finally {
      unmount();
    }
  });

  return results;
};
