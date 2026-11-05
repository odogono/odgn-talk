// The Sounds window (#2048): every Project sound, whatever is selected, with
// its Script name, size and Preview, and the ways to add, rename (#2050)
// and remove one. Edit only.
import { signal, type ReadonlySignal } from '@preact/signals';
import { render } from 'preact';
import { useEffect } from 'preact/hooks';
import type { StackEditor } from './editing';
import type { Asset } from './model';
import { decodeSound, isSoundAsset } from './sounds';

/** Why a listed sound can't play: its bytes are gone, or don't decode. */
export type SoundProblem = 'missing' | 'undecodable';

type SoundsProps = {
  /** The sound's bytes, if this session has them. */
  bytes: (asset: Asset) => Uint8Array | undefined;
  editor: StackEditor;
  previewName: ReadonlySignal<string | undefined>;
  /** Bumped by the shell's redraw, such as when stored bytes arrive. */
  redraw: ReadonlySignal<number>;
};

/** `2048` as `2 KB`. */
export const soundSize = (size: number): string =>
  size < 1024
    ? `${size} B`
    : size < 1024 * 1024
      ? `${Math.round(size / 1024)} KB`
      : `${(size / 1024 / 1024).toFixed(1)} MB`;

// Decoding is slow and a sound's bytes never change under its hash, so each
// hash decodes once per page; the verdicts signal redraws the window.
const checking = new Set<string>();
const decodes = signal<ReadonlyMap<string, boolean>>(new Map());
const check = (asset: Asset, bytes: Uint8Array): void => {
  if (checking.has(asset.hash)) {
    return;
  }
  checking.add(asset.hash);
  const verdict = (ok: boolean) => {
    decodes.value = new Map(decodes.value).set(asset.hash, ok);
  };
  decodeSound(
    new Blob([bytes as Uint8Array<ArrayBuffer>], { type: asset.mediaType }),
  ).then(
    () => verdict(true),
    () => verdict(false),
  );
};

const SoundsPanel = ({ bytes, editor, previewName, redraw }: SoundsProps) => {
  void redraw.value;
  const { project } = editor.state.value;
  const disabled = editor.readOnly;
  const preview = previewName.value;
  const sounds = project.assets.filter(isSoundAsset);
  const verdicts = decodes.value;
  useEffect(() => {
    for (const asset of sounds) {
      const found = bytes(asset);
      if (found) {
        check(asset, found);
      }
    }
  });
  const problem = (asset: Asset): SoundProblem | undefined =>
    !bytes(asset)
      ? 'missing'
      : verdicts.get(asset.hash) === false
        ? 'undecodable'
        : undefined;
  return (
    <>
      {sounds.length ? (
        <ul className="sound-list">
          {sounds.map(asset => {
            const why = problem(asset);
            return (
              <li
                className={why ? 'sound placeholder' : 'sound'}
                data-sound={asset.name}
                data-sound-problem={why}
                key={asset.name}
                title={asset.fileName}
              >
                <span className="sound-name">{asset.name}</span>
                <span className="muted">
                  {why === 'missing'
                    ? 'Missing'
                    : why === 'undecodable'
                      ? 'Can’t decode'
                      : soundSize(asset.size)}
                </span>
                <button
                  data-preview-sound={asset.name}
                  data-view-only=""
                  disabled={why !== undefined}
                  type="button"
                >
                  {preview === asset.name ? 'Stop' : 'Preview'}
                </button>
                <button
                  data-rename-sound={asset.name}
                  disabled={disabled}
                  type="button"
                >
                  Rename…
                </button>
                <button
                  data-remove-sound={asset.name}
                  disabled={disabled}
                  type="button"
                >
                  Remove…
                </button>
              </li>
            );
          })}
        </ul>
      ) : (
        <p className="muted">No sounds yet.</p>
      )}
      <div className="row">
        <button data-add-sound="" disabled={disabled} type="button">
          Add sound…
        </button>
        <button
          data-add-music-sound-dialog=""
          disabled={disabled}
          type="button"
        >
          Add from Music…
        </button>
      </div>
      <p className="muted">
        Scripts play a sound by its name, like tell sound to play
        &quot;waves&quot;. Add action… can write that for you.
      </p>
    </>
  );
};

/** Mount once; Preact redraws as the Project and the preview change. */
export const mountSoundsWindow = (
  container: HTMLElement,
  props: SoundsProps,
): (() => void) => {
  render(<SoundsPanel {...props} />, container);
  return () => render(null, container);
};
