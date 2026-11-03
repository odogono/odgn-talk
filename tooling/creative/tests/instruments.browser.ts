// Run on the dedicated test page described in README.md. Exercises editing
// Instruments in Info (#1894) and the built Instrument worklet in a real
// AudioWorklet.
import { createProject } from '../src/model';
import { INSTRUMENT_PROCESSOR } from '../src/instruments/rack';
import { mountStack } from '../src/stack';
import {
  INSTRUMENTS_REF,
  SYNTH_KIND,
  YM2149_KIND,
} from '../src/add-ons/instruments/ids';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};

/** Waits for Info to catch up with the editor. */
const settled = () => new Promise(resolve => setTimeout(resolve, 50));

const info = () => document.querySelector<HTMLElement>('#info')!;

/** The Instrument's fieldset in Info, by name. */
const fieldset = (name: string) =>
  [
    ...info().querySelectorAll<HTMLFieldSetElement>(
      'fieldset[data-instrument]',
    ),
  ].find(set =>
    set.querySelector('legend')!.textContent!.includes(`“${name}”`),
  );

/** Sets a control as a person would, then commits it with `change`. */
const commit = (
  control: HTMLInputElement | HTMLSelectElement,
  value: string | boolean,
) => {
  if (typeof value === 'boolean') {
    (control as HTMLInputElement).checked = value;
  } else {
    control.value = value;
  }
  control.dispatchEvent(new Event('change', { bubbles: true }));
};

/** Every Instrument control in Info. */
const controls = () => [
  ...info().querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    '[data-instrument] input, [data-instrument] select, [data-instrument] button, [data-new-instrument], [data-add-instrument]',
  ),
];

// An Add-on's kind loads its Add-on first, so adding one finishes later.
let shell: ReturnType<typeof mountStack>;

const add = async (kind: string) => {
  const before = shell.editor.project.instruments.length;
  commit(
    info().querySelector<HTMLSelectElement>('[data-new-instrument]')!,
    kind,
  );
  info().querySelector<HTMLButtonElement>('[data-add-instrument]')!.click();
  for (let i = 0; i < 100; i++) {
    if (shell.editor.project.instruments.length > before) {
      return;
    }
    await settled();
  }
  throw new Error(`No ${kind} was added`);
};

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => void | Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };
  shell = mountStack(createProject('Instrument browser check'));
  const instruments = () => shell.editor.project.instruments;

  await test('Info has no Instruments section until the Project lists an Instrument Add-on (#2025)', async () => {
    await settled();
    assert(
      !info().querySelector('[data-new-instrument]'),
      'A Project listing no Add-ons offers no Instruments',
    );
    const project = createProject('Instrument browser check');
    project.addOns = [INSTRUMENTS_REF];
    shell.editor.replaceProject(project);
    shell.redraw();
    await settled();
    const kinds = [
      ...info().querySelectorAll<HTMLOptionElement>(
        '[data-new-instrument] option',
      ),
    ].map(option => option.value);
    assert(
      kinds.join() === `sampler,${SYNTH_KIND},${YM2149_KIND}`,
      `Info offers the sampler and the listed Add-on's kinds: ${kinds.join()}`,
    );
  });

  await test('Info adds an Instrument of each kind with its defaults', async () => {
    assert(
      info().textContent!.includes('No Instruments yet.'),
      'An empty Project says so',
    );
    await add(SYNTH_KIND);
    await add(YM2149_KIND);
    await add('sampler');
    await settled();
    assert(
      instruments()
        .map(i => `${i.kind}:${i.name}`)
        .join() === `${SYNTH_KIND}:synth,${YM2149_KIND}:chip,sampler:drums`,
      `Three Instruments added, named for their kinds: ${instruments()
        .map(i => i.name)
        .join()}`,
    );
    assert(
      fieldset('synth') && fieldset('chip') && fieldset('drums'),
      'Info lists each',
    );
    await add(SYNTH_KIND);
    assert(
      shell.editor.project.addOns?.length === 1,
      'The Instruments Add-on is listed once',
    );
    assert(
      instruments()[3]!.name === 'synth2',
      'A second synth gets a fresh name',
    );
  });

  await test('parameters, voices and names commit as undoable edits', async () => {
    const synth = fieldset('synth')!;
    commit(synth.querySelector('[data-parameter="cutoff"]')!, '800');
    commit(synth.querySelector('[data-parameter="waveform"]')!, 'square');
    commit(synth.querySelector('[data-instrument-field="voices"]')!, '4');
    commit(fieldset('chip')!.querySelector('[data-parameter="noise"]')!, true);
    const [lead, chip] = instruments();
    assert(lead!.parameters.cutoff === 800, 'Cutoff set');
    assert(lead!.parameters.waveform === 'square', 'Waveform chosen');
    assert(lead!.voices === 4, 'Voices set');
    assert(chip!.parameters.noise === true, 'Noise switched on');
    commit(synth.querySelector('[data-instrument-field="name"]')!, 'bass');
    assert(instruments()[0]!.name === 'bass', 'Renamed');
    await settled();
    assert(fieldset('bass'), 'Info shows the new name');
    shell.editor.undo();
    shell.redraw();
    assert(instruments()[0]!.name === 'synth', 'Undo restores the name');
    shell.editor.redo();
    shell.redraw();
    assert(instruments()[0]!.name === 'bass', 'Redo renames again');
    await settled();
  });

  await test('refused values leave the Instrument and its field unchanged', async () => {
    const bass = fieldset('bass')!;
    const cutoff = bass.querySelector<HTMLInputElement>(
      '[data-parameter="cutoff"]',
    )!;
    commit(cutoff, '5');
    assert(instruments()[0]!.parameters.cutoff === 800, 'Cutoff kept');
    assert(cutoff.value === '800', 'The field shows the kept value');
    assert(
      !document.querySelector<HTMLElement>('#notice-banner')!.hidden,
      'A notice explains the refusal',
    );
    const name = bass.querySelector<HTMLInputElement>(
      '[data-instrument-field="name"]',
    )!;
    for (const taken of ['chip', 'page1', 'sound', '2bass']) {
      commit(name, taken);
      assert(instruments()[0]!.name === 'bass', `“${taken}” refused`);
    }
    assert(name.value === 'bass', 'The name field shows the kept name');
    commit(bass.querySelector('[data-instrument-field="voices"]')!, '99');
    assert(instruments()[0]!.voices === 4, 'Too many voices refused');
  });

  await test('Remove takes an Instrument out, and undo puts it back', async () => {
    fieldset('synth2')!
      .querySelector<HTMLButtonElement>('[data-remove-instrument]')!
      .click();
    assert(instruments().length === 3, 'Removed');
    await settled();
    assert(!fieldset('synth2'), 'Info no longer lists it');
    shell.editor.undo();
    shell.redraw();
    await settled();
    assert(fieldset('synth2'), 'Undo restores it');
  });

  await test('a read-only Project disables every Instrument control', async () => {
    assert(
      controls().every(c => !c.disabled),
      'Enabled while editable',
    );
    shell.editor.readOnly = true;
    shell.redraw();
    await settled();
    assert(
      controls().length > 0 && controls().every(c => c.disabled),
      'Disabled while read-only',
    );
    shell.editor.readOnly = false;
    shell.redraw();
  });

  await test('the built worklet plays every Instrument', async () => {
    const context = new OfflineAudioContext(2, 22_050, 44_100);
    await context.audioWorklet.addModule('./instruments.worklet.js');
    // The synth and YM2149 engines come from the Add-on's worklet module.
    await context.audioWorklet.addModule(
      './add-ons/instruments-1.0.0.worklet.js',
    );
    const node = new AudioWorkletNode(context, INSTRUMENT_PROCESSOR, {
      numberOfInputs: 0,
      outputChannelCount: [2],
      processorOptions: {
        setup: {
          instruments: [
            {
              kind: SYNTH_KIND,
              name: 'lead',
              voices: 4,
              parameters: { pan: -1 },
            },
            {
              kind: YM2149_KIND,
              name: 'chip',
              voices: 3,
              parameters: { pan: 1 },
            },
          ],
          samples: [],
        },
      },
    });
    node.connect(context.destination);
    // The node's port only takes the channel the Play worker sends on.
    const { port1: sending, port2: listening } = new MessageChannel();
    node.port.postMessage({ port: listening }, [listening]);
    // An offline render outruns the port, so pause it until the notes land.
    void context.suspend(128 / 44_100).then(async () => {
      sending.postMessage({
        instrument: 'lead',
        commands: [{ kind: 'note', note: 60, velocity: 1 }],
      });
      sending.postMessage({
        instrument: 'chip',
        commands: [{ kind: 'note', note: 69, velocity: 1 }],
      });
      await new Promise(resolve => setTimeout(resolve, 200));
      await context.resume();
    });
    const rendered = await context.startRendering();
    const peak = (channel: number) =>
      rendered
        .getChannelData(channel)
        .reduce((max, value) => Math.max(max, Math.abs(value)), 0);
    assert(peak(0) > 0.05, `The synth sounds on the left (${peak(0)})`);
    assert(peak(1) > 0.05, `The chip sounds on the right (${peak(1)})`);
  });

  shell.editor.replaceProject(createProject('Done'));
  shell.redraw();
  return results;
};
