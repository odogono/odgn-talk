import { expect, test } from 'bun:test';
import { EXAMPLE_PROJECTS } from '../src/examples';
import { PlaySession } from '../src/play';
import { scriptNameProblems } from '../src/script-names';

test('Example Projects have unique names and descriptions', () => {
  const names = EXAMPLE_PROJECTS.map(example => example.name);
  expect(new Set(names).size).toBe(names.length);
  for (const example of EXAMPLE_PROJECTS) {
    expect(example.description.length).toBeGreaterThan(0);
  }
});

for (const example of EXAMPLE_PROJECTS) {
  test(`${example.name} builds with its assets and starts playing cleanly`, async () => {
    const { project, assets } = await example.create();
    expect(project.name).toBe(example.name);
    for (const asset of project.assets) {
      expect(assets.has(asset.hash)).toBe(true);
    }
    expect(scriptNameProblems(project)).toEqual([]);
    const play = new PlaySession(project, 0, { events: true });
    for (let i = 0; i < 100 && play.pump(0n).state === 'sliced'; i++) {
      // Drain startPlay and openPage.
    }
    expect(play.problems).toEqual([]);
  });
}
