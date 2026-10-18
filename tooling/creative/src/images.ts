import { type DeepReadonly, thaw } from './readonly';
import { allElements } from './tree/rules';
// Image intake and the session's content-addressed bytes. Decode before any
// authored edit; retain bytes for undo and failed-save exports (#753). The
// bytes store is keyed by hash for every asset, so sound bytes (#822) live
// here too; sound intake and playback are in sounds.ts.
import type { Asset, Project } from './model';
import { sha256Hex } from './project-file';
import type { NewAsset } from './storage';

export const IMAGE_WARNING_SIZE = 10 * 1024 * 1024;
export const IMAGE_MAX_SIZE = 50 * 1024 * 1024;
export const IMAGE_ACCEPT =
  'image/png,image/jpeg,image/webp,image/gif,image/svg+xml,image/avif';
export type ImageDecoder = (blob: Blob) => Promise<void>;

/** SVG is decoded only in image mode, never inserted as markup. */
export const decodeImage: ImageDecoder = async blob => {
  const url = URL.createObjectURL(blob);
  try {
    const image = new Image();
    image.src = url;
    await image.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
};

const text = new TextDecoder();
// Enough for an XML declaration, comments and a DOCTYPE before <svg>.
const SVG_SNIFF_BYTES = 64 * 1024;

/** Identify supported containers from bytes, regardless of file name or MIME. */
const imageType = (bytes: Uint8Array): string | undefined => {
  const ascii = (start: number, end: number) =>
    text.decode(bytes.subarray(start, end));
  if ([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => bytes[i] === b)) {
    return 'image/png';
  }
  if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) {
    return 'image/jpeg';
  }
  if (['GIF87a', 'GIF89a'].includes(ascii(0, 6))) {
    return 'image/gif';
  }
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') {
    return 'image/webp';
  }
  if (ascii(4, 8) === 'ftyp') {
    const end = Math.min(
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(
        0,
      ),
      bytes.length,
    );
    for (let i = 8; i + 4 <= end; i += 4) {
      if (i !== 12 && ['avif', 'avis'].includes(ascii(i, i + 4))) {
        return 'image/avif';
      }
    }
  }
  if (
    /^\s*(?:<\?xml[\s\S]*?\?>\s*)?(?:<!--[\s\S]*?-->\s*)*(?:<!DOCTYPE[^>]*>\s*)?<svg[\s>]/u.test(
      ascii(0, SVG_SNIFF_BYTES),
    )
  ) {
    return 'image/svg+xml';
  }
  return undefined;
};

export type ImportedImage = {
  asset: Asset;
  bytes: Uint8Array;
  warnings: string[];
};

/** A refused file never changes the Project or its asset cache. */
export const importImage = async (
  file: Blob & { name?: string },
  decode: ImageDecoder = decodeImage,
): Promise<ImportedImage> => {
  const name = file.name || 'Image';
  if (file.size > IMAGE_MAX_SIZE) {
    throw new Error(
      `${name}: images above ${IMAGE_MAX_SIZE / 1024 / 1024} MB cannot be imported.`,
    );
  }
  const bytes = new Uint8Array(await file.arrayBuffer());
  const mediaType = imageType(bytes);
  if (!mediaType) {
    throw new Error(
      `${name}: unsupported image type. Choose PNG, JPEG, WebP, GIF, SVG or AVIF. To add a sound, use Add sound… in Info.`,
    );
  }
  try {
    await decode(new Blob([bytes], { type: mediaType }));
  } catch (error) {
    throw new Error(
      `${name}: the image could not be decoded (${error instanceof Error ? `${error.name}: ${error.message}` : String(error)}).`,
    );
  }
  const warnings: string[] = [];
  if (file.size > IMAGE_WARNING_SIZE) {
    warnings.push(
      `${name}: above ${IMAGE_WARNING_SIZE / 1024 / 1024} MB; large images can be slow on phones.`,
    );
  }
  if (mediaType === 'image/avif') {
    warnings.push(`${name}: AVIF may not display in older browsers.`);
  }
  return {
    asset: {
      name,
      fileName: name,
      hash: await sha256Hex(bytes),
      size: bytes.length,
      mediaType,
    },
    bytes,
    warnings,
  };
};

/** The storage form of image bytes. */
export const storageAsset = (
  bytes: Uint8Array,
  mediaType: string,
): NewAsset => ({
  blob: new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mediaType }),
  mediaType,
});

export class ImageAssets {
  readonly bytes = new Map<string, Uint8Array>();
  readonly #urls = new Map<string, string>();

  add(image: ImportedImage): void {
    if (!this.bytes.has(image.asset.hash)) {
      this.bytes.set(image.asset.hash, image.bytes);
    }
  }

  url(asset: Asset | undefined): string | undefined {
    if (!asset) {
      return undefined;
    }
    const bytes = this.bytes.get(asset.hash);
    if (!bytes) {
      return undefined;
    }
    let url = this.#urls.get(asset.hash);
    if (!url) {
      url = URL.createObjectURL(
        new Blob([bytes as Uint8Array<ArrayBuffer>], { type: asset.mediaType }),
      );
      this.#urls.set(asset.hash, url);
    }
    return url;
  }

  /** Only bytes named by this model enter its atomic storage transaction. */
  forStorage(project: DeepReadonly<Project>): Map<string, NewAsset> {
    const result = new Map<string, NewAsset>();
    for (const asset of project.assets) {
      const bytes = this.bytes.get(asset.hash);
      if (bytes) {
        result.set(asset.hash, storageAsset(bytes, asset.mediaType));
      }
    }
    return result;
  }

  dispose(): void {
    for (const url of this.#urls.values()) {
      URL.revokeObjectURL(url);
    }
    this.#urls.clear();
    this.bytes.clear();
  }
}

/** Keep names used by images. Scripts can also refer to asset names, so when
 * Scripts exist retain the table: dynamic references cannot be proven unused. */
export const projectForExport = (project: DeepReadonly<Project>): Project => {
  const copy = thaw<Project>(project);
  const scripted =
    project.script ||
    project.pages.some(
      p => p.script || allElements(p.elements).some(e => e.script),
    );
  if (!scripted) {
    const used = new Set(
      project.pages.flatMap(p =>
        allElements(p.elements).flatMap(e =>
          e.kind === 'image' ? [e.image] : [],
        ),
      ),
    );
    copy.assets = copy.assets.filter(a => used.has(a.name));
  }
  return copy;
};
