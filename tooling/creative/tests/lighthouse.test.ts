import { expect, test } from 'bun:test';
import { textOf, type Project, type TextElement } from '../src/model';
import { PlaySession } from '../src/play';
import { PlayHarness } from '../src/play-harness';
import { readProjectFile, writeProjectFile } from '../src/project-file';
import { projectForExport } from '../src/images';
import {
  createLighthouseProject,
  LIGHTHOUSE_PROJECT_NAME,
} from '../src/examples/lighthouse';
import { scriptNameProblems } from '../src/script-names';

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
  const game = await PlayHarness.start(project);
  const { play } = game;
  expect(play.problems).toEqual([]);

  // Without clues, the ending refuses.
  await game.click('toLighthouse');
  await game.click('toEnding');
  await game.click('solveButton');
  expect(game.text('verdict')).toContain('Still locked');
  await game.click('backToLighthouse');
  await game.click('backToHarbour');

  // Clue 1, with its bell, and the waves loop owned by this Page.
  await game.click('examineButton');
  expect(game.element('clueText').visible).toBe(true);
  expect(game.element('examineButton')).toHaveProperty(
    'label',
    'Tide chart examined',
  );
  await game.click('listenButton');
  expect(play.sounds.playing()).toContainEqual(
    expect.objectContaining({ name: 'waves', loop: true }),
  );

  // Leaving stops the Page-owned waves; arriving starts the lamp timer.
  await game.click('toLighthouse');
  expect(play.page.name).toBe('lighthouse');
  expect(play.sounds.playing()).toEqual([]);
  expect(game.text('lampNote')).toBe('The lamp is dark and cold.');
  await game.frame(2000);
  expect(game.text('lampNote')).toContain('swings in a draught');

  // A stray click is not the trapdoor and reveals nothing.
  await game.click('keyText');
  expect(game.element('keyText').visible).toBe(false);

  // The Page Script creates the trapdoor; its click reaches the Page
  // handler, reveals clue 2, and the trapdoor removes itself.
  await game.click('searchButton');
  expect(game.element('searchButton').visible).toBe(false);
  expect(game.element('trapdoor')).toHaveProperty('label', 'Open the trapdoor');
  await game.click('trapdoor');
  expect(game.element('keyText').visible).toBe(true);
  expect(play.page.elements.map(e => e.name)).not.toContain('trapdoor');

  // Revisiting keeps the changed visuals, restarts the Page Script and
  // keeps the Project Script's clues.
  await game.click('backToHarbour');
  expect(game.element('clueText').visible).toBe(true);
  await game.click('toLighthouse');
  await game.frame(2000);
  expect(game.element('keyText').visible).toBe(true);
  expect(game.text('lampNote')).toContain('swings in a draught');

  await game.click('toEnding');
  await game.click('solveButton');
  expect(game.text('verdict')).toContain('Mystery solved');
  expect(play.problems).toEqual([]);

  // Nothing above touched the authored Project, and a fresh session
  // starts from it exactly.
  expect(project).toEqual(authored);
  const fresh = new PlaySession(project);
  expect(fresh.project).toEqual(authored);
});

test('leaving the lamp room early cancels its wait with no late write', async () => {
  const { project } = await createLighthouseProject();
  const game = await PlayHarness.start(project);
  const { play } = game;
  await game.click('toLighthouse');
  await game.frame(500);
  await game.click('backToHarbour');
  await game.frame(4500);
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
  const game = await PlayHarness.start(loaded.project as Project);
  const { play } = game;
  await game.click('examineButton');
  expect(game.element('clueText').visible).toBe(true);
  expect(play.problems).toEqual([]);
});
