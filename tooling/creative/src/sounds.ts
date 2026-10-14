// Sound intake and playback (#822). Like images (#753), sounds are identified
// from their bytes and trial-decoded before any authored edit, with the asset
// size limits from #739. Playback ownership follows #735: a sound belongs to
// the Script that started it, so stopping that Script stops its sounds.
import type { Asset } from './model';
import { sha256Hex } from './project-file';

export const SOUND_WARNING_SIZE = 10 * 1024 * 1024;
export const SOUND_MAX_SIZE = 50 * 1024 * 1024;
export const SOUND_ACCEPT =
  'audio/mpeg,audio/mp4,audio/aac,audio/wav,audio/x-wav,.mp3,.m4a,.aac,.wav';
export type SoundDecoder = (blob: Blob) => Promise<void>;

/** Trial-decodes through an `<audio>` element, which never plays audibly. */
export const decodeSound: SoundDecoder = async blob => {
  const audio = new Audio();
  if (audio.canPlayType(blob.type) === '') {
    throw new Error(`this browser cannot play ${blob.type}`);
  }
  const url = URL.createObjectURL(blob);
  try {
    await new Promise<void>((resolve, reject) => {
      audio.addEventListener('loadeddata', () => resolve(), { once: true });
      audio.addEventListener(
        'error',
        () =>
          reject(
            audio.error ??
              new DOMException(
                'the sound could not be decoded',
                'EncodingError',
              ),
          ),
        { once: true },
      );
      audio.src = url;
      audio.load();
    });
  } finally {
    audio.removeAttribute('src');
    URL.revokeObjectURL(url);
  }
};

const text = new TextDecoder();

/** Identify supported containers from bytes, regardless of file name or MIME. */
const soundType = (bytes: Uint8Array): string | undefined => {
  const ascii = (start: number, end: number) =>
    text.decode(bytes.subarray(start, end));
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE') {
    return 'audio/wav';
  }
  if (ascii(0, 3) === 'ID3') {
    return 'audio/mpeg';
  }
  // MPEG audio frame sync: eleven set bits. ADTS AAC has layer bits 00;
  // MP3 frames name a layer, so the second byte tells them apart.
  if (bytes[0] === 255 && (bytes[1]! & 0xe0) === 0xe0) {
    return bytes[1] === 0xf1 || bytes[1] === 0xf9
      ? 'audio/aac'
      : (bytes[1]! & 0x06) !== 0
        ? 'audio/mpeg'
        : undefined;
  }
  if (ascii(4, 8) === 'ftyp') {
    const end = Math.min(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        0,
      ),
      bytes.length,
    );
    const brands = ['M4A ', 'M4B ', 'M4P ', 'mp41', 'mp42', 'isom', 'iso2'];
    for (let i = 8; i + 4 <= end; i += 4) {
      if (i !== 12 && brands.includes(ascii(i, i + 4))) {
        return 'audio/mp4';
      }
    }
  }
  return undefined;
};

export const isSoundAsset = (asset: Asset): boolean =>
  asset.mediaType.startsWith('audio/');

/** The Script-facing name of an imported sound: its file name, no extension. */
export const soundName = (fileName: string): string =>
  fileName.replace(/\.[A-Za-z0-9]{1,10}$/u, '') || 'sound';

export type ImportedSound = {
  asset: Asset;
  bytes: Uint8Array;
  warnings: string[];
};

/** A refused file never changes the Project or its asset cache. */
export const importSound = async (
  file: Blob & { name?: string },
  decode: SoundDecoder = decodeSound,
): Promise<ImportedSound> => {
  const name = file.name || 'Sound';
  if (file.size > SOUND_MAX_SIZE) {
    throw new Error(
      `${name}: sounds above ${SOUND_MAX_SIZE / 1024 / 1024} MB cannot be imported.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = soundType(bytes);
  if (!mediaType) {
    throw new Error(
      `${name}: unsupported sound type. Choose MP3, AAC (.m4a or .aac) or WAV.`,
    );
  }
  try {
    await decode(new Blob([bytes], { type: mediaType }));
  } catch (error) {
    throw new Error(
      `${name}: the sound could not be decoded (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}).`,
    );
  }
  const warnings: string[] = [];
  if (file.size > SOUND_WARNING_SIZE) {
    warnings.push(
      `${name}: above ${SOUND_WARNING_SIZE / 1024 / 1024} MB; large sounds make Projects slow to share.`,
    );
  }
  if (mediaType === 'audio/wav') {
    warnings.push(
      `${name}: WAV is uncompressed, so it makes the Project much larger than MP3 or AAC.`,
    );
  }
  return {
    asset: {
      name: soundName(name),
      fileName: name,
      hash: await sha256Hex(bytes),
      size: bytes.length,
      mediaType,
    },
    bytes,
    warnings,
  };
};

/** One playing voice, as the board and its tests see it. */
export type PlayingSound = { loop: boolean; name: string; owner: string };

/** Starts real playback for one voice; `onEnded` fires when it finishes. */
export type SoundBackend = (
  asset: Asset,
  loop: boolean,
  onEnded: () => void,
  onError: (message: string) => void,
) => { stop(): void };

/** Playback for tests and headless Hosts: tracks voices, makes no noise. */
export const silentSoundBackend: SoundBackend = () => ({ stop() {} });

/** Browser playback through an `<audio>` element per voice. */
export const browserSoundBackend =
  (urlFor: (asset: Asset) => string | undefined): SoundBackend =>
  (asset, loop, onEnded, onError) => {
    const url = urlFor(asset);
    if (!url) {
      throw new Error(
        `The sound “${asset.name}” is missing from this Project.`,
      );
    }
    const audio = new Audio(url);
    audio.loop = loop;
    audio.addEventListener('ended', onEnded, { once: true });
    void audio.play().catch((error: unknown) => {
      onError(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : String(error),
      );
    });
    return {
      stop() {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
      },
    };
  };

/**
 * The sounds playing in one Play Session, each owned by the Script that
 * started it (#735). `stop` from a Script reaches only its own sounds; the
 * session stops a Page's owners when it is left and every owner on Stop.
 */
export class SoundBoard {
  readonly #backend: SoundBackend;
  readonly #onError:
    ((sound: PlayingSound, message: string) => void) | undefined;
  readonly #voices = new Map<string, { sound: PlayingSound; stop(): void }>();

  constructor(
    backend: SoundBackend = silentSoundBackend,
    onError?: (sound: PlayingSound, message: string) => void,
  ) {
    this.#backend = backend;
    this.#onError = onError;
  }

  #key(owner: string, name: string): string {
    return `${owner}\0${name}`;
  }

  /** Starts `asset` for `owner`, restarting its voice of that name if any. */
  play(owner: string, asset: Asset, loop: boolean): void {
    const key = this.#key(owner, asset.name);
    this.#voices.get(key)?.stop();
    this.#voices.delete(key);
    const sound: PlayingSound = { owner, name: asset.name, loop };
    const voice = this.#backend(
      asset,
      loop,
      () => {
        if (this.#voices.get(key)?.sound === sound) {
          this.#voices.delete(key);
        }
      },
      message => {
        if (this.#voices.get(key)?.sound === sound) {
          this.#voices.delete(key);
        }
        this.#onError?.(sound, message);
      },
    );
    this.#voices.set(key, { sound, stop: () => voice.stop() });
  }

  /** Stops one of `owner`'s sounds, or all of them when no name is given. */
  stop(owner: string, name?: string): void {
    if (name !== undefined) {
      const key = this.#key(owner, name);
      this.#voices.get(key)?.stop();
      this.#voices.delete(key);
      return;
    }
    this.stopOwner(owner);
  }

  stopOwner(owner: string): void {
    for (const [key, voice] of this.#voices) {
      if (voice.sound.owner === owner) {
        voice.stop();
        this.#voices.delete(key);
      }
    }
  }

  stopAll(): void {
    for (const voice of this.#voices.values()) {
      voice.stop();
    }
    this.#voices.clear();
  }

  /** The sounds currently playing, in the order they started. */
  playing(): PlayingSound[] {
    return [...this.#voices.values()].map(voice => voice.sound);
  }
}
