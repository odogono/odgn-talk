// Dedicated page: control bindings (#1904). A knob bound to a synth's
// cutoff moves it with no Script, the page sending the change straight to
// the audio worklet; a meter shows the synth's output; Info binds in Edit.
import { CONTROLS_ADD_ON } from '../src/add-ons/controls';
import { INSTRUMENTS_REF, SYNTH_KIND } from '../src/add-ons/instruments/ids';
import { pageAddOns } from '../src/add-ons/page';
import { createAnyElement } from '../src/elements/registry';
import { createInstrument } from '../src/instruments/registry';
import { createElement, createProject, type AddOnKind } from '../src/model';
import { mountPlay } from '../src/play-view';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean, what: string) => {
  for (let i = 0; i < 250; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${what}`);
};
const kind = (name: string) => `${CONTROLS_ADD_ON}#${name}` as AddOnKind;

// What the page sends the worklet and the worker, to see a binding go
// straight to the audio and the worker only record it.
const toWorklet: { commands: { parameter?: string; value?: unknown }[] }[] = [];
const original = MessagePort.prototype.postMessage;
MessagePort.prototype.postMessage = function (
  this: MessagePort,
  message: unknown,
  ...rest: never[]
) {
  if (message && typeof message === 'object' && 'message' in message) {
    toWorklet.push(
      (message as { message: (typeof toWorklet)[number] }).message,
    );
  }
  return original.call(this, message, ...rest);
} as never;
const controlRequests: { applied?: boolean }[] = [];
const post = Worker.prototype.postMessage;
Worker.prototype.postMessage = function (
  this: Worker,
  message: unknown,
  ...rest: never[]
) {
  const request = (message as { request?: { kind?: string } })?.request;
  if (request?.kind === 'control') {
    controlRequests.push(request as { applied?: boolean });
  }
  return post.call(this, message, ...rest);
} as never;

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

  const problems = await pageAddOns.load([
    INSTRUMENTS_REF,
    { id: CONTROLS_ADD_ON, version: '1.0.0' },
  ]);
  assert(!problems.length, JSON.stringify(problems));
  const project = createProject('Bindings browser check');
  project.addOns = [INSTRUMENTS_REF, { id: CONTROLS_ADD_ON, version: '1.0.0' }];
  project.instruments.push(createInstrument(SYNTH_KIND, 'bass'));
  // No Script anywhere but the button that plays a note: the knob moves the
  // cutoff with no Run.
  const knob = {
    ...createAnyElement(kind('knob'), 'cutoff'),
    left: 20,
    top: 20,
    min: 20,
    max: 20_000,
    value: 1000,
    bindings: { value: 'bass.cutoff' },
  };
  const meter = {
    ...createAnyElement(kind('meter'), 'level'),
    left: 120,
    top: 20,
    bindings: { value: 'bass' },
  };
  const play = { ...createElement('button', 'play'), left: 200, top: 20 };
  play.script = 'on click {button: 0}\n tell bass to play "c3"\nend click';
  const resonance = {
    ...createAnyElement(kind('slider'), 'resonance'),
    left: 20,
    top: 200,
  };
  project.pages[0]!.elements.push(knob, meter, play, resonance);
  const shell = mountStack(project);
  mountPlay(shell);

  const reader = (name: string) =>
    document.querySelector<HTMLElement>(
      `#reader [data-element="${name}"] [role]`,
    )!;

  await test('Info binds a slider to a parameter and gives it the parameter’s range', async () => {
    shell.editor.click('resonance');
    shell.redraw();
    await until(
      () => !!document.querySelector('#info [data-binding="value"]'),
      'the binding menu',
    );
    const menu = document.querySelector<HTMLSelectElement>(
      '#info [data-binding="value"]',
    )!;
    const options = [...menu.options].map(o => o.value);
    assert(
      options.includes('tempo') && options.includes('bass.resonance'),
      `the menu offers ${options.join(', ')}`,
    );
    menu.value = 'bass.resonance';
    menu.dispatchEvent(new Event('change', { bubbles: true }));
    const bound = shell.editor.page.elements[3] as unknown as {
      bindings?: Record<string, string>;
      max: number;
      min: number;
    };
    assert(
      bound.bindings?.value === 'bass.resonance' &&
        bound.min === 0 &&
        bound.max === 1,
      `bound with range ${bound.min} to ${bound.max}`,
    );
    shell.editor.undo();
    shell.editor.click('cutoff');
    shell.redraw();
  });

  document.querySelector<HTMLButtonElement>('#menu [aria-pressed]')!.click();
  await until(() => !!reader('cutoff'), 'Present shows the knob');

  // The meter rising also shows the audio is running before the drag.
  await test('a meter bound to the synth shows its output', async () => {
    document
      .querySelector<HTMLElement>('#reader [data-element="play"]')!
      .click();
    await until(
      () => Number(reader('level').getAttribute('aria-valuenow')) > 0,
      'the meter to rise',
    );
  });
  await test('dragging a bound knob sends the cutoff to the audio, not through a Run', async () => {
    const node = reader('cutoff');
    const box = node.getBoundingClientRect();
    const at = (y: number) => ({
      bubbles: true,
      pointerId: 1,
      clientX: box.left + box.width / 2,
      clientY: y,
    });
    node.dispatchEvent(new PointerEvent('pointerdown', at(box.top + 30)));
    for (let step = 1; step <= 10; step++) {
      node.dispatchEvent(
        new PointerEvent('pointermove', at(box.top + 30 - step * 5)),
      );
    }
    node.dispatchEvent(new PointerEvent('pointerup', at(box.top - 20)));
    await until(
      () => toWorklet.some(m => m.commands.some(c => c.parameter === 'cutoff')),
      'the worklet to hear the cutoff',
    );
    const last = toWorklet
      .flatMap(m => m.commands)
      .filter(c => c.parameter === 'cutoff')
      .at(-1)!;
    assert(
      Math.abs(
        Number(last.value) - Number(node.getAttribute('aria-valuenow')),
      ) < 1,
      `the last cutoff sent, ${last.value}, is the knob's`,
    );
    await until(() => controlRequests.length > 0, 'the worker to hear it');
    assert(
      controlRequests.every(request => request.applied === true),
      'the worker is told the audio already has it',
    );
    assert(
      document.getElementById('errors-window')?.hidden !== false,
      'no errors',
    );
  });

  document.querySelector<HTMLButtonElement>('#menu [aria-pressed]')!.click();
  return results;
};
