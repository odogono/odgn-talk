// Base Projects (ADR 0161): the Projects that ship with Folio and that a
// new Project starts as a copy of. Blank is built here with no file;
// Music is written by the build to a `.folio` file that the service
// worker keeps once fetched. Each carries every sound it plays, and a
// copy records which Base Project and version it came from.
import { CONTROLS_REF } from './add-ons/controls/ids';
import { PIANO_ROLL_REF } from './add-ons/piano-roll/ids';
import { INSTRUMENTS_REF, synthInstrument } from './add-ons/instruments/ids';
import { KIT_SOUND_KEYS, renderKitSound } from './kits/kits';
import {
  type Asset,
  type BaseProjectName,
  createProject,
  type Project,
} from './model';
import { fetchKeptFile } from './open-url';
import { readProjectFile, sha256Hex } from './project-file';

/** Bumped whenever Music's content changes; build tests hold the two together. */
export const MUSIC_BASE_VERSION = 7;
export const BLANK_BASE_VERSION = 1;

/** The most bytes a Base Project's `.folio` file may take. */
export const BASE_BUDGET_BYTES = 512 * 1024;

/** The file the build writes for a Base Project, under Folio. */
export const baseFilePath = (name: 'music'): string => `projects/${name}.folio`;

/** A kit sound, by its sampler key such as `bd:1`, as a Project's own sound. */
export const kitSoundAsset = async (
  key: string,
): Promise<{ asset: Asset; bytes: Uint8Array }> => {
  const bytes = renderKitSound(key);
  return {
    asset: {
      name: key,
      fileName: `${key.replace(':', '-')}.wav`,
      hash: await sha256Hex(bytes),
      mediaType: 'audio/wav',
      size: bytes.length,
    },
    bytes,
  };
};

const MUSIC_SCRIPT = `-- Every kit sound is this Project's own: bd, sd, hh, oh, cp and more.
-- Remove the dashes below to hear a beat when Play starts. While it
-- plays, edit the pattern and press ⌘↩ to hear it change on the next bar.
-- on openScript
--   loop "bd hh sd hh"
-- end openScript
`;

/** Builds the Music Base Project and its asset bytes. */
export const createMusicBase = async (): Promise<{
  assets: Map<string, Uint8Array>;
  project: Project;
}> => {
  const project = createProject('Music');
  project.base = { name: 'music', version: MUSIC_BASE_VERSION };
  // Music's synth is the Instruments Add-on's (#1901), and it offers the
  // controls, which a Project offers only when it lists them (#2025), and
  // the Piano Roll for its patterns (#2181).
  project.addOns = [INSTRUMENTS_REF, CONTROLS_REF, PIANO_ROLL_REF];
  project.instruments.push(synthInstrument('bass'));
  project.script = MUSIC_SCRIPT;
  const assets = new Map<string, Uint8Array>();
  for (const key of KIT_SOUND_KEYS) {
    const { asset, bytes } = await kitSoundAsset(key);
    assets.set(asset.hash, bytes);
    project.assets.push(asset);
  }
  return { assets, project };
};

/**
 * A new Project as a copy of a Base Project, named `name`. Blank is built
 * here; Music is fetched from the file the build wrote, so offline it
 * opens only once it has been fetched online.
 */
export const createFromBase = async (
  base: BaseProjectName,
  name: string,
  fetchFn: typeof fetch = fetch,
): Promise<{ assets: Map<string, Uint8Array>; project: Project }> => {
  if (base === 'blank') {
    const project = createProject(name);
    project.base = { name: 'blank', version: BLANK_BASE_VERSION };
    return { assets: new Map(), project };
  }
  const read = await readProjectFile(
    await fetchKeptFile(baseFilePath(base), fetchFn),
  );
  read.project.name = name;
  return { assets: read.assets, project: read.project };
};
