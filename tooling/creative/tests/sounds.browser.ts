// Run on the dedicated test page described in README.md. Exercises the real
// audio decoder, the Add sound picker and browser playback voices.
import { createElement, createProject } from '../src/model';
import { PlaySession } from '../src/play';
import { browserSoundBackend, decodeSound, importSound } from '../src/sounds';
import { mountStack } from '../src/stack';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean) => {
  for (let i = 0; i < 100; i++) {
    if (check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for the editor');
};

/** A quarter second of 440 Hz PCM in a WAV container, made in memory. */
const wavFile = (): File => {
  const samples = 2000;
  const bytes = new Uint8Array(44 + samples * 2);
  const view = new DataView(bytes.buffer);
  const ascii = (at: number, value: string) =>
    [...value].forEach((char, i) => view.setUint8(at + i, char.charCodeAt(0)));
  ascii(0, 'RIFF');
  view.setUint32(4, bytes.length - 8, true);
  ascii(8, 'WAVEfmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true);
  view.setUint32(28, 16_000, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  ascii(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i++) {
    view.setInt16(
      44 + i * 2,
      Math.round(Math.sin((i / 8000) * Math.PI * 2 * 440) * 8000),
      true,
    );
  }
  return new File([bytes], 'waves.wav', { type: 'audio/wav' });
};

const pickSound = (file: File) => {
  const nativePicker = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    this.files = transfer.files;
    this.dispatchEvent(new Event('change'));
  };
  try {
    document
      .querySelector<HTMLButtonElement>('#info [data-add-sound]')!
      .click();
  } finally {
    HTMLInputElement.prototype.click = nativePicker;
  }
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
  const project = createProject('Sound browser check');
  project.pages[0]!.elements.push(createElement('button', 'door'));
  const shell = mountStack(project);

  await test('the real decoder accepts a WAV and refuses junk', async () => {
    const sound = await importSound(wavFile());
    assert(sound.asset.mediaType === 'audio/wav', 'WAV sniffed and decoded');
    let refused = false;
    try {
      await decodeSound(new Blob(['not audio'], { type: 'audio/wav' }));
    } catch {
      refused = true;
    }
    assert(refused, 'Junk does not decode');
  });

  await test('Add sound imports through the picker as one undoable edit', async () => {
    pickSound(wavFile());
    await until(() => shell.editor.project.assets.length === 1);
    assert(
      shell.editor.project.assets[0]!.name === 'waves',
      'Sound named for Scripts',
    );
    assert(
      document
        .querySelector('#info')!
        .textContent!.includes('waves (waves.wav)'),
      'Info lists the sound',
    );
    shell.editor.undo();
    shell.redraw();
    assert(shell.editor.project.assets.length === 0, 'Undo removes the sound');
    shell.editor.redo();
    shell.redraw();
    assert(shell.editor.project.assets.length === 1, 'Redo restores the sound');
  });

  await test('a Script loops the sound in Play and Stop silences it', () => {
    shell.editor.edit(({ project, tree }) => {
      tree.setScript(
        project.pages[0]!.elements[0]!,
        'on click\n tell sound to loop "waves"\nend click',
      );
    });
    const play = new PlaySession(shell.editor.project, 0, {
      soundBackend: browserSoundBackend(asset => shell.images.url(asset)),
    });
    play.send(play.page.elements[0]!, 'click');
    // No awaits here: check the voice before any autoplay verdict can land.
    for (let i = 0; i < 100 && play.pump(0n).state === 'sliced'; i++) {
      // Drain the bounded Pump slices.
    }
    assert(
      play.sounds.playing().some(s => s.name === 'waves' && s.loop),
      'The click started a looping voice',
    );
    play.stop(0n);
    assert(play.sounds.playing().length === 0, 'Stop silences the voice');
  });

  shell.editor.replaceProject(createProject('Done'));
  shell.redraw();
  return results;
};
