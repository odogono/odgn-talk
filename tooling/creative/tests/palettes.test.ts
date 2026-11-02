// Palettes (#1903): authored like Pages, kept after them, saved apart from
// them, and shown by Play in their own windows with Scripts that outlast
// Page changes.
import { expect, test } from 'bun:test';
import { StackEditor } from '../src/editing';
import {
  createElement,
  createPage,
  createPalette,
  createProject,
  pageCount,
  pagesOf,
  palettesOf,
  type Project,
} from '../src/model';
import { PlaySession } from '../src/play';
import {
  migrateProjectJson,
  readProjectFile,
  serializeProject,
  validateProjectJson,
  writeProjectFile,
} from '../src/project-file';

/** Pumps with a turn between, so Page changes finish. */
const advance = async (play: PlaySession) => {
  for (let i = 0; i < 100; i++) {
    const result = play.pump(0n);
    await Promise.resolve();
    if (result.state !== 'sliced') {
      return;
    }
  }
  throw new Error('Did not become idle');
};

const drain = (play: PlaySession) => {
  for (let i = 0; i < 100; i++) {
    if (play.pump(0n).state !== 'sliced') {
      return;
    }
  }
  throw new Error('Did not become idle');
};

/** Two Pages, then a Palette with a button. */
const withPalette = (): Project => {
  const project = createProject('Mixer');
  project.pages.push(createPage('page2'));
  const palette = createPalette('mixer');
  palette.palette.title = 'The mixer';
  palette.elements.push(createElement('button', 'go'));
  project.pages.push(palette);
  return project;
};

test('Palettes are kept after the Pages and counted apart from them', () => {
  const project = withPalette();
  expect(pageCount(project)).toBe(2);
  expect(pagesOf(project).map(p => p.name)).toEqual(['page1', 'page2']);
  expect(palettesOf(project).map(p => p.name)).toEqual(['mixer']);
});

test('a Project file keeps Palettes in their own list and reads them back', async () => {
  const project = withPalette();
  const json = serializeProject(project);
  expect((json.pages as unknown[]).length).toBe(2);
  expect(json.palettes).toMatchObject([
    {
      name: 'mixer',
      title: 'The mixer',
      width: 240,
      height: 160,
      openOnPlay: true,
      elements: [{ kind: 'button', name: 'go' }],
    },
  ]);
  const read = await readProjectFile(
    await writeProjectFile(project, new Map()),
  );
  expect(read.project).toEqual(project);
});

test('a Project without Palettes writes no palettes list', () => {
  expect(serializeProject(createProject('Plain'))).not.toHaveProperty(
    'palettes',
  );
});

test('format 10 Projects read with no Palettes', () => {
  const json = { ...serializeProject(createProject('Old')), format: 10 };
  const result = validateProjectJson(migrateProjectJson(json));
  expect(result).toHaveProperty('project.pages.length', 1);
});

test('a Palette must not share a Page name, and says where', () => {
  const json = serializeProject(withPalette());
  (json.palettes as { name: string }[])[0]!.name = 'page2';
  expect(validateProjectJson(json)).toMatchObject({
    issues: [{ path: 'palettes[0].name' }],
  });
});

test('a Palette needs its width and opening setting', () => {
  const json = serializeProject(withPalette());
  const [palette] = json.palettes as Record<string, unknown>[];
  delete palette!.width;
  palette!.openOnPlay = 'yes';
  expect(validateProjectJson(json)).toMatchObject({
    issues: [{ path: 'palettes[0].openOnPlay' }, { path: 'palettes[0].width' }],
  });
});

test('Edit adds a Palette after the Pages, and Pages before it', () => {
  const editor = new StackEditor(createProject('Edit'));
  const palette = editor.addPalette();
  expect(editor.page).toBe(palette);
  expect(palette.palette).toEqual({ width: 240, openOnPlay: true });
  // Adding a Page while a Palette shows puts it after the last Page.
  const page = editor.addPage();
  expect(editor.project.pages.map(p => p.name)).toEqual([
    'page1',
    'page2',
    'palette1',
  ]);
  expect(editor.page).toBe(page);
  editor.undo();
  editor.undo();
  expect(editor.project.pages.map(p => p.name)).toEqual(['page1']);
});

test('Pages and Palettes each move only among their own kind', () => {
  const editor = new StackEditor(withPalette());
  editor.edit(({ tree }) => tree.addPalette());
  editor.movePage(1, 2);
  expect(editor.project.pages.map(p => p.name)).toEqual([
    'page1',
    'page2',
    'mixer',
    'palette2',
  ]);
  editor.movePage(3, 2);
  expect(editor.project.pages.map(p => p.name)).toEqual([
    'page1',
    'page2',
    'palette2',
    'mixer',
  ]);
});

test('next and previous step within the Pages or within the Palettes', () => {
  const editor = new StackEditor(withPalette());
  editor.goToPage(1);
  editor.nextPage();
  expect(editor.pageIndex).toBe(1);
  editor.goToPage(2);
  editor.previousPage();
  expect(editor.pageIndex).toBe(2);
});

test('the last Page cannot be deleted, but a Palette can', () => {
  const project = createProject('Edit');
  project.pages.push(createPalette('mixer'));
  const editor = new StackEditor(project);
  editor.goToPage(0);
  expect(editor.canDelete).toBe(false);
  editor.goToPage(1);
  expect(editor.canDelete).toBe(true);
  editor.delete();
  expect(editor.project.pages.map(p => p.name)).toEqual(['page1']);
  expect(editor.pageIndex).toBe(0);
});

test('Info sets a Palette’s title, width and opening, each undoable', () => {
  const editor = new StackEditor(withPalette());
  editor.goToPage(2);
  editor.edit(({ tree, project }) => {
    const palette = project.pages[2]!;
    tree.setProperty(palette, 'paletteTitle', '');
    tree.setProperty(palette, 'paletteWidth', 300);
    tree.setProperty(palette, 'openOnPlay', false);
  });
  expect(editor.page.palette).toEqual({ width: 300, openOnPlay: false });
  editor.undo();
  expect(editor.page.palette).toEqual({
    width: 240,
    openOnPlay: true,
    title: 'The mixer',
  });
  expect(() =>
    editor.edit(({ tree, project }) =>
      tree.setProperty(project.pages[0]!, 'paletteWidth', 300),
    ),
  ).toThrow('Only a Palette has this');
});

test('Palette Scripts load when Play starts and outlast Page changes', async () => {
  const project = withPalette();
  const palette = project.pages[2]!;
  palette.script = 'on later\n pass later\nend later';
  palette.elements[0]!.script = [
    'on click',
    ' set the label of me to "went"',
    ' tell pages to show page2',
    'end click',
    'on later',
    ' set the label of me to "still here"',
    'end later',
  ].join('\n');
  const play = new PlaySession(project);
  drain(play);
  expect(play.messageTargets.map(t => t.label)).toEqual([
    'palette:mixer',
    'element:mixer/go',
  ]);
  const go = play.project.pages[2]!.elements[0]!;
  play.send(go, 'click');
  await advance(play);
  expect(play.problems).toEqual([]);
  expect(play.page.name).toBe('page2');
  // Its Script still runs on the new Page.
  play.send(go, 'later' as never);
  drain(play);
  expect(go).toHaveProperty('label', 'still here');
  play.stop(0n);
});

test('a Palette’s Element Scripts see its Elements and it as thisPage', () => {
  const project = withPalette();
  const palette = project.pages[2]!;
  palette.elements.push(createElement('text', 'readout'));
  palette.elements[0]!.script =
    'on click\n set the text of readout to the name of thisPage\nend click';
  const play = new PlaySession(project);
  play.send(play.project.pages[2]!.elements[0]!, 'click');
  drain(play);
  expect(play.problems).toEqual([]);
  expect(play.project.pages[2]!.elements[1]).toHaveProperty('richText', [
    { runs: [{ text: 'mixer' }] },
  ]);
});

test('show and hide open and close a Palette; go to refuses one', () => {
  const project = withPalette();
  const palette = project.pages[2]!;
  palette.palette!.openOnPlay = false;
  project.pages[0]!.elements.push(createElement('button', 'toggle'));
  project.pages[0]!.elements[0]!.script =
    'on click\n show mixer\nend click\non hideIt\n hide mixer\nend hideIt\non goIt\n tell pages to show mixer\nend goIt';
  const play = new PlaySession(project);
  drain(play);
  expect([...play.openPalettes]).toEqual([]);
  const toggle = play.page.elements[0]!;
  play.send(toggle, 'click');
  drain(play);
  expect([...play.openPalettes]).toEqual(['mixer']);
  play.send(toggle, 'hideIt' as never);
  drain(play);
  expect([...play.openPalettes]).toEqual([]);
  play.send(toggle, 'goIt' as never);
  drain(play);
  expect(play.problems).toMatchObject([
    { line: 8, message: '"pages" failed while doing "show"' },
  ]);
  expect(play.page.name).toBe('page1');
});

test('a Palette set to open when Play starts is open; the reader may close it', () => {
  const play = new PlaySession(withPalette());
  expect([...play.openPalettes]).toEqual(['mixer']);
  play.setPaletteOpen('mixer', false);
  expect([...play.openPalettes]).toEqual([]);
  play.setPaletteOpen('nothing', true);
  expect([...play.openPalettes]).toEqual([]);
});

test('Play started on a Palette starts on the first Page', () => {
  const play = new PlaySession(withPalette(), 2);
  expect(play.page.name).toBe('page1');
});

test('a Palette can float in Perform, saved only when set (#2001)', () => {
  const editor = new StackEditor(withPalette());
  editor.edit(({ tree, project }) =>
    tree.setProperty(project.pages[2]!, 'floatInPerform', true),
  );
  expect(editor.project.pages[2]!.palette?.float).toBe(true);
  const json = serializeProject(editor.project);
  expect((json.palettes as Record<string, unknown>[])[0]!.float).toBe(true);
  expect(validateProjectJson(json)).toHaveProperty(
    'project.pages.2.palette.float',
    true,
  );
  editor.edit(({ tree, project }) =>
    tree.setProperty(project.pages[2]!, 'floatInPerform', false),
  );
  expect(editor.project.pages[2]!.palette).not.toHaveProperty('float');
  (json.palettes as Record<string, unknown>[])[0]!.float = 'yes';
  expect(validateProjectJson(json)).toMatchObject({
    issues: [{ path: 'palettes[0].float' }],
  });
});
