// First Sounds on the Play harness (#1898): every Page loops its layers,
// mutes each one, changes its grooves on the next bar, and leads on.
import { expect, test } from 'bun:test';
import {
  createFirstSoundsProject,
  grooveButtonName,
  LESSONS,
  muteButtonName,
  START_TEMPO,
  tempoButtonName,
  TEMPOS,
} from '../src/examples/first-sounds';
import { DEFAULT_KIT_INSTRUMENT } from '../src/kits/kits';
import { patternProblems, projectPatternNames } from '../src/pattern-checks';
import { PlayHarness } from '../src/play-harness';

const BAR_MS = (60_000 / START_TEMPO) * 4;

const start = async () => {
  const { project } = await createFirstSoundsProject();
  return PlayHarness.start(project);
};

/** The Instrument and sound or note of each note sent from `from` on. */
const heard = (game: PlayHarness, from: number) =>
  game.notes(from).map(note => note.split(' ').slice(1).join(' '));

/** What a layer sends while the harness plays `bars` bars. */
const layerNotes = (game: PlayHarness, from: number, instrument: string) =>
  heard(game, from).filter(note => note.startsWith(`${instrument} `));

test('First Sounds walks every Lesson in order, a Page each', async () => {
  const { project } = await createFirstSoundsProject();
  expect(project.pages.map(page => page.name)).toEqual(
    LESSONS.map(lesson => lesson.name),
  );
  for (const page of project.pages) {
    for (const element of page.elements) {
      expect(element.left + element.width).toBeLessThanOrEqual(
        project.designWidth,
      );
      expect(element.top + element.height).toBeLessThanOrEqual(page.height);
    }
  }
});

for (const [index, lesson] of LESSONS.entries()) {
  test(`${lesson.title} loops its layers, mutes each and changes the groove`, async () => {
    const game = await start();
    for (let i = 0; i < index; i++) {
      await game.click('next');
    }
    expect(game.play.page.name).toBe(lesson.name);
    expect(game.play.problems).toEqual([]);

    // Each layer plays from the next bar.
    let from = game.sent.length;
    await game.advance(BAR_MS * 2);
    for (const layer of lesson.layers) {
      expect(
        layerNotes(game, from, layer.instrument ?? DEFAULT_KIT_INSTRUMENT)
          .length,
      ).toBeGreaterThan(0);
    }

    // Muting a layer silences it, leaving the others; Unmute brings it back.
    for (const layer of lesson.layers) {
      const instrument = layer.instrument ?? DEFAULT_KIT_INSTRUMENT;
      const mute = muteButtonName(layer.name);
      await game.click(mute);
      expect(game.element(mute)).toMatchObject({
        label: `Unmute ${layer.name}`,
      });
      await game.advance(BAR_MS);
      from = game.sent.length;
      await game.advance(BAR_MS * 2);
      expect(layerNotes(game, from, instrument)).toEqual([]);
      for (const other of lesson.layers.filter(l => l !== layer)) {
        expect(
          layerNotes(game, from, other.instrument!).length,
        ).toBeGreaterThan(0);
      }
      await game.click(mute);
      expect(game.element(mute)).toMatchObject({
        label: `Mute ${layer.name}`,
      });
      from = game.sent.length;
      await game.advance(BAR_MS * 2);
      expect(layerNotes(game, from, instrument).length).toBeGreaterThan(0);
    }

    // Each groove button changes its layer, so its notes change.
    for (const [i, groove] of lesson.grooves.entries()) {
      const layer = lesson.layers.find(l => l.name === groove.layer)!;
      const instrument = layer.instrument ?? DEFAULT_KIT_INSTRUMENT;
      from = game.sent.length;
      await game.advance(BAR_MS);
      const before = layerNotes(game, from, instrument);
      await game.click(grooveButtonName(i));
      await game.advance(BAR_MS);
      from = game.sent.length;
      await game.advance(BAR_MS * 2);
      expect(layerNotes(game, from, instrument).join()).not.toBe(
        [...before, ...before].join(),
      );
    }
    expect(game.play.problems).toEqual([]);
  });
}

test('a muted layer stays muted until its groove changes', async () => {
  const game = await start();
  await game.click(muteButtonName('beat'));
  await game.click(grooveButtonName(0));
  expect(game.element(muteButtonName('beat'))).toMatchObject({
    label: 'Mute beat',
  });
  await game.advance(BAR_MS);
  const from = game.sent.length;
  await game.advance(BAR_MS);
  expect(heard(game, from)).toEqual([`${DEFAULT_KIT_INSTRUMENT} sd`]);
});

test('leaving a Page stops its layers before the next Page loops its own', async () => {
  const game = await start();
  await game.advance(BAR_MS * 2);
  await game.click('next');
  await game.advance(BAR_MS);
  const from = game.sent.length;
  await game.advance(BAR_MS);
  // A bar of "bd hh sd hh" alone: the first Page's "bd" has stopped.
  expect([...heard(game, from)].sort()).toEqual(
    ['bd', 'hh', 'hh', 'sd'].map(s => `${DEFAULT_KIT_INSTRUMENT} ${s}`),
  );
});

test('the tempo buttons change how fast the bars play', async () => {
  const game = await start();
  for (let i = 1; i < LESSONS.length; i++) {
    await game.click('next');
  }
  expect(game.text('tempoText')).toBe(`${START_TEMPO} beats a minute`);
  for (const tempo of TEMPOS) {
    await game.click(tempoButtonName(tempo));
    expect(game.text('tempoText')).toBe(`${tempo} beats a minute`);
    await game.advance(BAR_MS * 2);
    const from = game.sent.length;
    await game.advance(BAR_MS * 2);
    const kicks = game
      .notes(from)
      .filter(note => note.includes(' kick '))
      .map(note => Number(note.split(' ')[0]));
    const gap = kicks[1]! - kicks[0]!;
    // "bd*4" plays a kick each beat.
    expect(gap).toBeCloseTo(60 / tempo, 6);
  }
});

test('every pattern a Page loops is valid Mini-Notation', async () => {
  const { project } = await createFirstSoundsProject();
  for (const page of project.pages) {
    expect(
      patternProblems(page.script ?? '', projectPatternNames(project)),
    ).toEqual([]);
  }
});

test('Back returns to the Page before', async () => {
  const game = await start();
  await game.click('next');
  await game.click('back');
  expect(game.play.page.name).toBe(LESSONS[0]!.name);
});
