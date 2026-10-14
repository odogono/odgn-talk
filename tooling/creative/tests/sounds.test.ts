import { expect, test } from 'bun:test';
import { StackEditor } from '../src/editing';
import { projectForExport } from '../src/images';
import { createProject, type Asset } from '../src/model';
import { readProjectFile, writeProjectFile } from '../src/project-file';
import {
  importSound,
  SoundBoard,
  SOUND_MAX_SIZE,
  SOUND_WARNING_SIZE,
  type SoundBackend,
} from '../src/sounds';

const decode = async () => {};
const mp3 = new TextEncoder().encode('ID3fake-mp3-bytes');
const wav = new TextEncoder().encode('RIFF0000WAVEfmt ');

test('sniffs MP3, AAC, M4A and WAV from bytes and names sounds without extensions', async () => {
  const examples = [
    [mp3, 'audio/mpeg'],
    [new Uint8Array([0xff, 0xfb, 0x90, 0]), 'audio/mpeg'],
    [new Uint8Array([0xff, 0xf1, 0x50, 0x80]), 'audio/aac'],
    [
      new Uint8Array([
        0,
        0,
        0,
        24,
        ...new TextEncoder().encode('ftypM4A 0000M4A mp42'),
      ]),
      'audio/mp4',
    ],
    [wav, 'audio/wav'],
  ] as const;
  for (const [bytes, type] of examples) {
    const sound = await importSound(
      new File([bytes], 'waves.bin', { type: 'image/png' }),
      decode,
    );
    expect(sound.asset.mediaType).toBe(type);
    expect(sound.asset.name).toBe('waves');
    expect(sound.asset.fileName).toBe('waves.bin');
    expect(sound.warnings.some(w => w.includes('WAV is uncompressed'))).toBe(
      type === 'audio/wav',
    );
  }
});

test('refuses unsupported and undecodable sounds and enforces the asset size limits', async () => {
  await expect(
    importSound(new File(['fLaCnot-audio'], 'song.flac'), decode),
  ).rejects.toThrow('unsupported sound type. Choose MP3, AAC');
  await expect(
    importSound(new File([mp3], 'broken.mp3'), async () => {
      throw new DOMException('broken data', 'EncodingError');
    }),
  ).rejects.toThrow('could not be decoded (EncodingError: broken data)');
  let called = false;
  await expect(
    importSound(
      new File([new Uint8Array(SOUND_MAX_SIZE + 1)], 'huge.mp3'),
      async () => {
        called = true;
      },
    ),
  ).rejects.toThrow('above 50 MB');
  expect(called).toBe(false);
  const large = new Uint8Array(SOUND_WARNING_SIZE + 1);
  large.set(mp3);
  expect(
    (await importSound(new File([large], 'large.mp3'), decode)).warnings,
  ).toHaveLength(1);
  const exact = new Uint8Array(SOUND_WARNING_SIZE);
  exact.set(mp3);
  expect(
    (await importSound(new File([exact], 'exact.mp3'), decode)).warnings,
  ).toHaveLength(0);
});

const asset = (name: string): Asset => ({
  name,
  fileName: `${name}.mp3`,
  hash: 'a'.repeat(64),
  mediaType: 'audio/mpeg',
  size: mp3.length,
});

const recordingBackend = () => {
  const voices: {
    end(): void;
    fail(message: string): void;
    name: string;
    stopped: boolean;
  }[] = [];
  const backend: SoundBackend = (a, _loop, onEnded, onError) => {
    const voice = {
      name: a.name,
      stopped: false,
      end: onEnded,
      fail: onError,
    };
    voices.push(voice);
    return {
      stop() {
        voice.stopped = true;
      },
    };
  };
  return { backend, voices };
};

test('a sound belongs to its Script: stop reaches only the owner’s voices', () => {
  const { backend, voices } = recordingBackend();
  const board = new SoundBoard(backend);
  board.play('element:page1/door', asset('waves'), false);
  board.play('project', asset('waves'), true);
  board.play('element:page1/door', asset('rain'), true);
  expect(board.playing()).toEqual([
    { owner: 'element:page1/door', name: 'waves', loop: false },
    { owner: 'project', name: 'waves', loop: true },
    { owner: 'element:page1/door', name: 'rain', loop: true },
  ]);
  // Another Script stopping "waves" cannot silence the Element's voice.
  board.stop('project', 'waves');
  expect(board.playing().map(s => s.owner)).toEqual([
    'element:page1/door',
    'element:page1/door',
  ]);
  expect(voices[1]!.stopped).toBe(true);
  expect(voices[0]!.stopped).toBe(false);
  // `stop` with no name stops all of that Script's sounds.
  board.stop('element:page1/door');
  expect(board.playing()).toEqual([]);
  expect(voices.every(v => v.stopped)).toBe(true);
});

test('replaying restarts a voice and a finished or failed voice leaves the board', () => {
  const { backend, voices } = recordingBackend();
  const errors: string[] = [];
  const board = new SoundBoard(backend, (sound, message) =>
    errors.push(`${sound.name}: ${message}`),
  );
  board.play('project', asset('waves'), false);
  board.play('project', asset('waves'), false);
  expect(voices[0]!.stopped).toBe(true);
  expect(board.playing()).toHaveLength(1);
  voices[1]!.end();
  expect(board.playing()).toEqual([]);
  board.play('project', asset('rain'), true);
  voices[2]!.fail('NotAllowedError: blocked');
  expect(board.playing()).toEqual([]);
  expect(errors).toEqual(['rain: NotAllowedError: blocked']);
});

test('stopOwner and stopAll silence exactly their scope', () => {
  const { backend } = recordingBackend();
  const board = new SoundBoard(backend);
  board.play('page:page1', asset('waves'), true);
  board.play('project', asset('rain'), true);
  board.stopOwner('page:page1');
  expect(board.playing()).toEqual([
    { owner: 'project', name: 'rain', loop: true },
  ]);
  board.stopAll();
  expect(board.playing()).toEqual([]);
});

test('adding a sound is one undoable edit and identical bytes keep one name', async () => {
  const sound = await importSound(new File([mp3], 'waves.mp3'), decode);
  const project = createProject('Story');
  const editor = new StackEditor(project);
  const before = structuredClone(project);
  expect(editor.addSound(sound.asset)).toBe('waves');
  expect(editor.addSound({ ...sound.asset, name: 'sea' })).toBe('waves');
  expect(project.assets).toHaveLength(1);
  const other = await importSound(new File([wav], 'waves.wav'), decode);
  expect(editor.addSound(other.asset)).toBe('waves2');
  editor.undo();
  expect(project.assets.map(a => a.name)).toEqual(['waves']);
  editor.undo();
  expect(project).toEqual(before);
  editor.redo();
  expect(project.assets.map(a => a.name)).toEqual(['waves']);
  editor.readOnly = true;
  editor.addSound(other.asset);
  expect(project.assets).toHaveLength(1);
});

test('sounds survive export and import, and unused sounds follow the Script rule', async () => {
  const sound = await importSound(new File([mp3], 'waves.mp3'), decode);
  const project = createProject('Story');
  project.assets.push(sound.asset);
  const bytes = new Map([[sound.asset.hash, sound.bytes]]);
  const loaded = await readProjectFile(await writeProjectFile(project, bytes));
  expect(loaded.project).toEqual(project);
  expect([...loaded.assets.get(sound.asset.hash)!]).toEqual([...mp3]);
  expect(loaded.missingAssets).toEqual([]);
  // Without a Script nothing can play the sound, so export drops it; with
  // one, a Script may choose it by name dynamically, so it stays.
  expect(projectForExport(project).assets).toEqual([]);
  project.script = 'on startPlay\n tell sound to loop "waves"\nend startPlay';
  expect(projectForExport(project).assets).toEqual([sound.asset]);
  const missing = await readProjectFile(
    await writeProjectFile(project, new Map(), { allowMissing: true }),
  );
  expect(missing.missingAssets).toEqual([sound.asset]);
});
