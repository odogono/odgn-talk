import { expect, test } from 'bun:test';
import {
  textOf,
  type Element,
  type Project,
  type TextElement,
} from '../src/model';
import { PlaySession } from '../src/play';
import { readProjectFile, writeProjectFile } from '../src/project-file';
import { projectForExport } from '../src/images';
import {
  createLighthouseProject,
  LIGHTHOUSE_PROJECT_NAME,
} from '../src/examples/lighthouse';
import { scriptNameProblems } from '../src/script-names';

const advance = async (play: PlaySession, now = 0n) => {
  for (let i = 0; i < 100; i++) {
    const result = play.pump(now);
    await Promise.resolve();
    if (result.state !== 'sliced') {
      return result;
    }
  }
  throw new Error('Did not become idle');
};

const element = (play: PlaySession, name: string): Element =>
  play.page.elements.find(e => e.name === name)!;

const click = async (play: PlaySession, name: string, now = 0n) => {
  play.send(element(play, name), 'click');
  await advance(play, now);
};

const text = (play: PlaySession, name: string): string =>
  textOf(element(play, name) as TextElement);

test('the sample is a valid three-Page Project with illustrations, sounds and a journal', async () => {
  const { project, assets } = await createLighthouseProject();
  expect(project.name).toBe(LIGHTHOUSE_PROJECT_NAME);
  expect(project.pages.map(p => p.name)).toEqual([
    'harbour',
    'lighthouse',
    'ending',
  ]);
  expect(scriptNameProblems(project)).toEqual([]);
  expect(project.assets.map(a => a.name)).toEqual([
    'harbour.svg',
    'lighthouse.svg',
    'cellar.svg',
    'bell',
    'waves',
  ]);
  for (const asset of project.assets) {
    expect(assets.get(asset.hash)?.length).toBe(asset.size);
  }
  for (const page of project.pages) {
    expect(page.elements.some(e => e.kind === 'image')).toBe(true);
  }
  const journal = project.pages[0]!.elements.find(e => e.name === 'journal')!;
  expect(journal).toMatchObject({ kind: 'text', editable: true });
  // The trapdoor is created during Play; it is not authored.
  expect(project.pages.flatMap(p => p.elements.map(e => e.name))).not.toContain(
    'trapdoor',
  );
});

test('the mystery plays end to end: clues, dynamic trapdoor, and the Project Script settles it', async () => {
  const { project } = await createLighthouseProject();
  const authored = structuredClone(project);
  const play = new PlaySession(project);
  await advance(play);
  expect(play.problems).toEqual([]);

  // Without clues, the ending refuses.
  await click(play, 'toLighthouse');
  await click(play, 'toEnding');
  await click(play, 'solveButton');
  expect(text(play, 'verdict')).toContain('Still locked');
  await click(play, 'backToLighthouse');
  await click(play, 'backToHarbour');

  // Clue 1, with its bell, and the waves loop owned by this Page.
  await click(play, 'examineButton');
  expect(element(play, 'clueText').visible).toBe(true);
  expect(element(play, 'examineButton')).toHaveProperty(
    'label',
    'Tide chart examined',
  );
  await click(play, 'listenButton');
  expect(play.sounds.playing()).toContainEqual(
    expect.objectContaining({ name: 'waves', loop: true }),
  );

  // Leaving stops the Page-owned waves; arriving starts the lamp timer.
  await click(play, 'toLighthouse');
  expect(play.page.name).toBe('lighthouse');
  expect(play.sounds.playing()).toEqual([]);
  expect(text(play, 'lampNote')).toBe('The lamp is dark and cold.');
  await advance(play, 2_000_000n);
  expect(text(play, 'lampNote')).toContain('swings in a draught');

  // A stray click is not the trapdoor and reveals nothing.
  await click(play, 'keyText', 2_000_000n);
  expect(element(play, 'keyText').visible).toBe(false);

  // The Page Script creates the trapdoor; its click reaches the Page
  // handler, reveals clue 2, and the trapdoor removes itself.
  await click(play, 'searchButton', 2_000_000n);
  expect(element(play, 'searchButton').visible).toBe(false);
  expect(element(play, 'trapdoor')).toHaveProperty(
    'label',
    'Open the trapdoor',
  );
  await click(play, 'trapdoor', 2_000_000n);
  expect(element(play, 'keyText').visible).toBe(true);
  expect(play.page.elements.map(e => e.name)).not.toContain('trapdoor');

  // Revisiting keeps the changed visuals, restarts the Page Script and
  // keeps the Project Script's clues.
  await click(play, 'backToHarbour', 2_000_000n);
  expect(element(play, 'clueText').visible).toBe(true);
  await click(play, 'toLighthouse', 2_000_000n);
  await advance(play, 4_000_000n);
  expect(element(play, 'keyText').visible).toBe(true);
  expect(text(play, 'lampNote')).toContain('swings in a draught');

  await click(play, 'toEnding', 4_000_000n);
  await click(play, 'solveButton', 4_000_000n);
  expect(text(play, 'verdict')).toContain('Mystery solved');
  expect(play.problems).toEqual([]);

  // Nothing above touched the authored Project, and a fresh session
  // starts from it exactly.
  expect(project).toEqual(authored);
  const fresh = new PlaySession(project);
  expect(fresh.project).toEqual(authored);
});

test('leaving the lamp room early cancels its wait with no late write', async () => {
  const { project } = await createLighthouseProject();
  const play = new PlaySession(project);
  await advance(play);
  await click(play, 'toLighthouse');
  await click(play, 'backToHarbour', 500_000n);
  await advance(play, 5_000_000n);
  const lamp = play.project.pages[1]!.elements.find(
    e => e.name === 'lampNote',
  )! as TextElement;
  expect(textOf(lamp)).toBe('The lamp is dark and cold.');
  expect(play.problems).toEqual([]);
});

test('the sample exports, reopens from the file alone and plays the same', async () => {
  const { project, assets } = await createLighthouseProject();
  const file = await writeProjectFile(projectForExport(project), assets);
  const loaded = await readProjectFile(file);
  expect(loaded.missingAssets).toEqual([]);
  expect(loaded.project).toEqual(projectForExport(project));
  for (const asset of project.assets) {
    expect([...loaded.assets.get(asset.hash)!]).toEqual([
      ...assets.get(asset.hash)!,
    ]);
  }
  const play = new PlaySession(loaded.project as Project);
  await advance(play);
  await click(play, 'examineButton');
  expect(element(play, 'clueText').visible).toBe(true);
  expect(play.problems).toEqual([]);
});
