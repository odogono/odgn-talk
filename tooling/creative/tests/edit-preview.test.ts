// Edit-time preview (#2269): the scratch session and auditioning one step of
// a pattern (#2190) on the pattern's Instrument.
import { expect, test } from 'bun:test';
import { withMusicSounds } from './music-sounds';
import { createProject } from '../src/model';
import { auditionStep, editPreview } from '../src/edit-preview';
import { settle } from '../src/message';
import { synthInstrument } from '../src/add-ons/instruments/ids';
import { SYNTH_KIND, YM2149_KIND } from './helpers/instruments';

const notes = (messages: unknown) =>
  (
    messages as {
      commands: { kind: string; note?: number }[];
      instrument: string;
    }[]
  ).flatMap(m =>
    m.commands.map(c => `${m.instrument}:${c.kind}:${c.note ?? ''}`),
  );

test('a note plays on the pattern’s Instrument', async () => {
  const project = createProject('Tune');
  project.instruments.push(synthInstrument('lead') as never);
  const sent = await auditionStep(project, 'e4', 'lead');
  expect(notes(sent)).toContain('lead:note:64');
  // Its session's end stops nothing, or the note would never sound.
  expect(notes(sent).some(n => n.includes(':stop:'))).toBe(false);
});

test('a sound plays on the default sampler without an Instrument', async () => {
  const sent = await auditionStep(withMusicSounds(createProject('Beat')), 'bd');
  expect(Array.isArray(sent) && sent.length).toBeGreaterThan(0);
});

test('a name that is no step, or an unknown Instrument, says why', async () => {
  expect(await auditionStep(createProject('X'), 'c4"; stop')).toHaveProperty(
    'problem',
  );
  expect(await auditionStep(createProject('X'), 'c4', 'nobody')).toHaveProperty(
    'problem',
  );
});

for (const kind of [SYNTH_KIND, YM2149_KIND]) {
  test(`a preview keeps the notes and none of the stops of ${kind.split('#')[1]}`, async () => {
    const project = createProject('Tune');
    project.instruments.push({
      name: 'voice',
      kind,
      voices: 3,
      parameters: {},
    } as never);
    const preview = editPreview(project);
    const started = preview.play.runMessage('play "c4 e4" on voice');
    expect(started.ok).toBe(true);
    if (started.ok) {
      await settle(preview.play, started.result, () => preview.play.pump(0n));
    }
    const sent = notes(preview.finish());
    expect(sent).toContain('voice:note:60');
    expect(sent.some(n => n.includes(':stop:'))).toBe(false);
  });
}
