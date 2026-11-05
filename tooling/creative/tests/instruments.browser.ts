// Run on the dedicated test page described in README.md. Exercises editing
// Instruments in the Instruments window (#1894, #2049, #2079) and the built
// Instrument worklet in a real AudioWorklet.
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

/** Waits for the window to catch up with the editor. */
const settled = () => new Promise(resolve => setTimeout(resolve, 50));

const panel = () => document.querySelector<HTMLElement>('#instruments-panel')!;

/** The listed Instrument's row, by name. */
const row = (name: string) =>
  [...panel().querySelectorAll<HTMLElement>('[data-select-instrument]')].find(
    item => item.querySelector('.instrument-name')!.textContent === name,
  );

/** The detail of the selected Instrument, if it is the one named. */
const detail = (name: string) => {
  const set = panel().querySelector<HTMLElement>('[data-instrument]');
  return set?.querySelector<HTMLInputElement>('[data-instrument-field="name"]')
    ?.value === name
    ? set
    : undefined;
};

/** Selects an Instrument in the list, then returns its detail. */
const fieldset = async (name: string) => {
  row(name)?.click();
  await settled();
  return detail(name);
};

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

/** A number parameter's slider and typed value in `set`. */
const slider = (set: HTMLElement, name: string) =>
  set.querySelector<HTMLElement>(`.slider[data-parameter="${name}"]`)!;
const valueField = (set: HTMLElement, name: string) =>
  set.querySelector<HTMLInputElement>(`[data-parameter-value="${name}"]`)!;

const pointer = (
  target: HTMLElement,
  type: string,
  x: number,
  init: PointerEventInit = {},
) =>
  target.dispatchEvent(
    new PointerEvent(type, {
      bubbles: true,
      button: 0,
      clientX: target.getBoundingClientRect().left + x,
      pointerId: 1,
      ...init,
    }),
  );

const key = (target: HTMLElement, init: KeyboardEventInit) =>
  target.dispatchEvent(
    new KeyboardEvent('keydown', { bubbles: true, ...init }),
  );

/** The hint's Script lines. */
const hint = () =>
  panel().querySelector('[data-instrument-hint]')!.textContent!;

/** Every Instrument control in the window. */
const controls = () => [
  ...panel().querySelectorAll<HTMLInputElement | HTMLButtonElement>(
    '[data-instrument] input, [data-instrument] button, [data-add-menu], [data-remove-instrument]',
  ),
];

// An Add-on's kind loads its Add-on first, so adding one finishes later.
let shell: ReturnType<typeof mountStack>;

/** The kinds the `+ ▾` menu offers, leaving it closed. */
const offeredKinds = async () => {
  panel().querySelector<HTMLButtonElement>('[data-add-menu]')!.click();
  await settled();
  const kinds = [
    ...panel().querySelectorAll<HTMLElement>('[data-add-instrument]'),
  ].map(item => item.dataset.addInstrument);
  panel().querySelector<HTMLButtonElement>('[data-add-menu]')!.click();
  await settled();
  return kinds;
};

const add = async (kind: string) => {
  const before = shell.editor.project.instruments.length;
  panel().querySelector<HTMLButtonElement>('[data-add-menu]')!.click();
  await settled();
  panel()
    .querySelector<HTMLButtonElement>(`[data-add-instrument="${kind}"]`)!
    .click();
  for (let i = 0; i < 100; i++) {
    if (shell.editor.project.instruments.length > before) {
      await settled();
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
  // Sliders need a size, so the window is open.
  document.querySelector<HTMLElement>('#instruments-window')!.hidden = false;
  const instruments = () => shell.editor.project.instruments;
  const synthParameters = () => instruments()[0]!.parameters;

  await test('the + menu offers the sampler in any Project, and Info offers no Instruments (#2049)', async () => {
    await settled();
    assert(
      !document.querySelector('#info [data-add-instrument]'),
      'Info has no Instruments section',
    );
    const offered = await offeredKinds();
    assert(
      offered.join() === 'sampler',
      `A Project listing no Add-ons offers the sampler: ${offered.join()}`,
    );
    const project = createProject('Instrument browser check');
    project.addOns = [INSTRUMENTS_REF];
    shell.editor.replaceProject(project);
    shell.redraw();
    await settled();
    const kinds = await offeredKinds();
    assert(
      kinds.join() === `sampler,${SYNTH_KIND},${YM2149_KIND}`,
      `The menu offers the sampler and the listed Add-on's kinds: ${kinds.join()}`,
    );
  });

  await test('the + menu adds an Instrument of each kind with its defaults', async () => {
    assert(
      panel().textContent!.includes('No Instruments yet.'),
      'An empty Project says so',
    );
    await add(SYNTH_KIND);
    await add(YM2149_KIND);
    await add('sampler');
    assert(
      instruments()
        .map(i => `${i.kind}:${i.name}`)
        .join() === `${SYNTH_KIND}:synth,${YM2149_KIND}:chip,sampler:drums`,
      `Three Instruments added, named for their kinds: ${instruments()
        .map(i => i.name)
        .join()}`,
    );
    assert(row('synth') && row('chip') && row('drums'), 'The list shows each');
    assert(
      !row('synth')!.textContent!.match(/\d/u),
      'The list shows no voice count',
    );
    assert(
      panel().querySelectorAll('[data-instrument]').length === 1 &&
        detail('synth'),
      'Only the first Instrument’s detail shows',
    );
    assert(await fieldset('drums'), 'Selecting one shows its detail');
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

  await test('parameters sit in collapsible groups, and collapsing one is remembered', async () => {
    const synth = (await fieldset('synth'))!;
    const groups = [
      ...synth.querySelectorAll<HTMLDetailsElement>('details[data-group]'),
    ];
    assert(
      groups.map(g => g.dataset.group).join() ===
        'Oscillator,Envelope,Filter,Output',
      `The synth's groups: ${groups.map(g => g.dataset.group).join()}`,
    );
    const envelope = groups[1]!;
    envelope.open = false;
    await settled();
    assert(
      localStorage
        .getItem('northtalk-creative-collapsed-instrument-groups')
        ?.includes('Envelope'),
      'The collapsed group is remembered',
    );
    shell.redraw();
    await settled();
    assert(
      !synth.querySelector<HTMLDetailsElement>('[data-group="Envelope"]')!.open,
      'It stays collapsed after a redraw',
    );
    synth.querySelector<HTMLDetailsElement>('[data-group="Envelope"]')!.open =
      true;
    await settled();
  });

  await test('parameters, voices and names commit as undoable edits', async () => {
    commit(
      (await fieldset('chip'))!.querySelector('[data-parameter="noise"]')!,
      true,
    );
    const synth = (await fieldset('synth'))!;
    commit(valueField(synth, 'cutoff'), '800');
    synth
      .querySelector<HTMLButtonElement>(
        '[data-parameter="waveform"] [data-choice="square"]',
      )!
      .click();
    commit(synth.querySelector('[data-instrument-field="voices"]')!, '4');
    const [lead, chip] = instruments();
    assert(lead!.parameters.cutoff === 800, 'Cutoff set');
    assert(lead!.parameters.waveform === 'square', 'Waveform chosen');
    assert(lead!.voices === 4, 'Voices set');
    assert(chip!.parameters.noise === true, 'Noise switched on');
    commit(synth.querySelector('[data-instrument-field="name"]')!, 'bass');
    assert(instruments()[0]!.name === 'bass', 'Renamed');
    await settled();
    assert(detail('bass') && row('bass'), 'The window shows the new name');
    shell.editor.undo();
    shell.redraw();
    assert(instruments()[0]!.name === 'synth', 'Undo restores the name');
    shell.editor.redo();
    shell.redraw();
    assert(instruments()[0]!.name === 'bass', 'Redo renames again');
    await settled();
  });

  await test('typing a value takes a Quantity in the parameter’s Unit Kind', async () => {
    const bass = (await fieldset('bass'))!;
    commit(valueField(bass, 'attack'), '5 ms');
    assert(synthParameters().attack === 0.005, 'Attack is 5 ms');
    await settled();
    assert(
      valueField(bass, 'attack').value === '5 ms',
      `The field shows ${valueField(bass, 'attack').value}`,
    );
    commit(valueField(bass, 'cutoff'), '1.2 kHz');
    assert(synthParameters().cutoff === 1200, 'Cutoff is 1.2 kHz');
    commit(valueField(bass, 'attack'), '1 kg');
    assert(synthParameters().attack === 0.005, 'A mass is refused');
    assert(
      valueField(bass, 'attack').value === '5 ms',
      'The field goes back to the stored value',
    );
    commit(valueField(bass, 'cutoff'), '800');
  });

  await test('sliders step with the keyboard, reset to default and drag finer with ⇧', async () => {
    const bass = (await fieldset('bass'))!;
    const cutoff = slider(bass, 'cutoff');
    assert(
      cutoff.getAttribute('aria-label') === 'Cutoff (Hz)' &&
        valueField(bass, 'cutoff').getAttribute('aria-label') ===
          'Cutoff (Hz) value',
      'Accessible names include the Unit',
    );
    key(cutoff, { key: 'ArrowRight' });
    const stepped = synthParameters().cutoff as number;
    assert(stepped > 800, `ArrowRight raises the cutoff (${stepped})`);
    await settled();
    key(cutoff, { key: 'ArrowLeft', shiftKey: true });
    const fine = synthParameters().cutoff as number;
    assert(
      fine < stepped && stepped - fine < (stepped - 800) / 5,
      `⇧ArrowLeft steps finer (${stepped} → ${fine})`,
    );
    await settled();
    cutoff.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 2 }));
    assert(synthParameters().cutoff === 4000, 'A double-click resets it');
    commit(valueField(bass, 'cutoff'), '800');
    await settled();
    pointer(slider(bass, 'cutoff'), 'pointerdown', 5, { altKey: true });
    assert(synthParameters().cutoff === 4000, '⌥-click resets it');
    await settled();
    // A plain drag across a tenth of the pan slider moves it a tenth of its
    // range; with ⇧ the same drag moves it a hundredth.
    const pan = slider(bass, 'pan');
    const width = pan.getBoundingClientRect().width;
    const before = synthParameters().pan;
    pointer(pan, 'pointerdown', width / 2);
    await settled();
    pointer(pan, 'pointermove', width / 2 + width / 10);
    await settled();
    pointer(pan, 'pointerup', width / 2 + width / 10);
    const coarse = synthParameters().pan as number;
    assert(Math.abs(coarse - 0.2) < 0.02, `A drag moves pan to ${coarse}`);
    shell.editor.undo();
    assert(synthParameters().pan === before, 'One undo takes the drag back');
    shell.editor.redo();
    shell.redraw();
    await settled();
    pointer(pan, 'pointerdown', width / 2, { shiftKey: true });
    await settled();
    pointer(pan, 'pointermove', width / 2 + width / 10, { shiftKey: true });
    await settled();
    pointer(pan, 'pointerup', width / 2 + width / 10, { shiftKey: true });
    const fineDrag = (synthParameters().pan as number) - coarse;
    assert(
      Math.abs(fineDrag - 0.02) < 0.005,
      `⇧ drags ten times finer (${fineDrag})`,
    );
  });

  await test('the hint names the selected Instrument and the hovered row', async () => {
    await fieldset('drums');
    assert(
      hint().includes('tell drums to play "kick"'),
      `A sampler's hint: ${hint()}`,
    );
    const bass = (await fieldset('bass'))!;
    assert(
      hint().includes('tell bass to play 60') &&
        hint().includes('set the cutoff of bass to 4.0 kHz'),
      `A synth's hint: ${hint()}`,
    );
    bass
      .querySelector('[data-parameter-row="attack"]')!
      .dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    bass
      .querySelector('[data-parameter-row="attack"]')!
      .dispatchEvent(new MouseEvent('mouseenter'));
    await settled();
    assert(
      hint().includes('set the attack of bass to 5 ms'),
      `Hovering a row shows its line: ${hint()}`,
    );
  });

  await test('refused values leave the Instrument and its field unchanged', async () => {
    const bass = (await fieldset('bass'))!;
    commit(valueField(bass, 'cutoff'), '800');
    commit(valueField(bass, 'cutoff'), '5');
    assert(instruments()[0]!.parameters.cutoff === 800, 'Cutoff kept');
    await settled();
    assert(
      valueField(bass, 'cutoff').value === '800 Hz',
      'The field shows the kept value',
    );
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

  await test('⌘D and the + menu duplicate the selected Instrument', async () => {
    await fieldset('bass');
    const list = panel().querySelector<HTMLElement>('.instrument-list')!;
    key(list, { key: 'd', metaKey: true });
    await settled();
    const copy = instruments()[1]!;
    assert(
      copy.name === 'bass2' &&
        copy.kind === SYNTH_KIND &&
        copy.voices === 4 &&
        copy.parameters.cutoff === 800,
      `⌘D copies kind, voices and parameters: ${JSON.stringify(copy)}`,
    );
    assert(detail('bass2'), 'The copy is selected');
    panel().querySelector<HTMLButtonElement>('[data-add-menu]')!.click();
    await settled();
    panel()
      .querySelector<HTMLButtonElement>('[data-duplicate-instrument]')!
      .click();
    await settled();
    assert(instruments()[2]!.name === 'bass3', 'Duplicate in the menu too');
    shell.editor.undo();
    shell.editor.undo();
    shell.redraw();
    await settled();
    assert(
      instruments().length === 4,
      `Undo takes both copies out: ${instruments()
        .map(i => i.name)
        .join()}`,
    );
  });

  await test('− and Delete remove an Instrument, and undo puts it back', async () => {
    await fieldset('synth2');
    panel()
      .querySelector<HTMLButtonElement>('[data-remove-instrument]')!
      .click();
    assert(instruments().length === 3, 'Removed');
    await settled();
    assert(!row('synth2'), 'The list no longer shows it');
    assert(detail('bass'), 'The first Instrument is selected instead');
    shell.editor.undo();
    shell.redraw();
    await settled();
    assert(row('synth2'), 'Undo restores it');
    await fieldset('synth2');
    key(panel().querySelector<HTMLElement>('.instrument-list')!, {
      key: 'Delete',
    });
    assert(instruments().length === 3, 'Delete removes it');
    shell.editor.undo();
    shell.redraw();
    await settled();
  });

  await test('a read-only Project disables every Instrument control', async () => {
    await fieldset('bass');
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
    assert(
      [...panel().querySelectorAll('.slider')].every(s =>
        s.hasAttribute('aria-disabled'),
      ),
      'Sliders are disabled while read-only',
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
