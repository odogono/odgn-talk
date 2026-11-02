// The Project file format (#748; layout from #739): a zip holding a
// `mimetype` entry first, a deflated `project.json` with an integer
// `format` version, and one stored `assets/<sha256>.<ext>` per asset.
// Files hold the authored Project only, never Play State (ADR 0041).
import type { DeepReadonly } from './readonly';
import {
  isPageAlignX,
  isPageAlignY,
  projectWithoutIds,
  BASE_PROJECT_NAMES,
  type AddOnRef,
  type Asset,
  type BaseProjectName,
  type Element,
  type ElementBase,
  type Instrument,
  type Page,
  type Project,
} from './model';
import {
  Checker,
  isObj,
  setDefined,
  type Obj,
  type ValidationIssue,
} from './elements/checker';
import {
  addOnIdProblem,
  placeholderKind,
  splitAddOnKind,
} from './elements/add-on';
import { migrateInstrumentKinds } from './add-ons/instruments/migration';
import { isElementKind, kindOf } from './elements/registry';
import { migrateClicks } from './click-migration';
import { migrateSounds } from './sound-migration';
import { defaultParameters } from './instruments/kind';
import { INSTRUMENT_KINDS, instrumentProblems } from './instruments/registry';
import { testScriptNameProblem } from './script-names';
import { readZip, writeZip, ZipError, type ZipEntry } from './zip';

export const PROJECT_MIMETYPE = 'application/vnd.odgn.northtalk-project+zip';
export const CURRENT_FORMAT = 11;
const APP = 'northtalk-creative';

export type { ValidationIssue } from './elements/checker';

/** Any failure to read or write a Project file. Never a half-read Project. */
export class ProjectFileError extends Error {
  readonly issues?: ValidationIssue[];

  constructor(message: string, issues?: ValidationIssue[]) {
    super(message);
    this.issues = issues;
  }
}

/** The lowercase hex SHA-256 of `bytes`, as assets are keyed by it. */
export const sha256Hex = async (bytes: Uint8Array): Promise<string> => {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    bytes as Uint8Array<ArrayBuffer>,
  );
  return [...new Uint8Array(digest)]
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
};

const EXTENSION_BY_MEDIA_TYPE: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
  'image/gif': 'gif',
  'image/svg+xml': 'svg',
  'image/avif': 'avif',
  'audio/mpeg': 'mp3',
  'audio/mp4': 'm4a',
  'audio/aac': 'aac',
  'audio/ogg': 'ogg',
  'audio/wav': 'wav',
  'audio/x-wav': 'wav',
};

/** The zip entry name for an asset; the extension is only for people. */
export const assetEntryName = (asset: Asset): string => {
  const fromFile = /\.([A-Za-z0-9]{1,10})$/u.exec(asset.fileName)?.[1];
  const ext = (
    fromFile ??
    EXTENSION_BY_MEDIA_TYPE[asset.mediaType] ??
    'bin'
  ).toLowerCase();
  return `assets/${asset.hash}.${ext}`;
};

// --- Validation: unknown JSON in, a Project or every problem out -----------

// The builders below run even after a failure, so one read reports every
// problem. Their placeholder values are discarded whenever issues exist.

const checkElement = (
  c: Checker,
  value: unknown,
  path: string,
  depth = 0,
): Element | undefined => {
  const e = c.obj(value, path);
  if (!e) {
    return undefined;
  }
  if (c.elements.has(e)) {
    c.fail(path, 'an Element must have exactly one parent');
    return undefined;
  }
  c.elements.add(e);
  const name = c.name(e.name, `${path}.name`) ?? '';
  if (c.names.has(name)) {
    c.fail(`${path}.name`, 'another Element on this Page has this name');
  }
  c.names.add(name);
  const k = e.kind;
  if (!isElementKind(k)) {
    c.fail(`${path}.kind`, `unknown Element kind ${JSON.stringify(e.kind)}`);
    return undefined;
  }
  return kindOf(k).check(c, e, path, {
    addOns: c.addOns,
    name,
    depth,
    member: (raw, at) => checkElement(c, raw, at, depth + 1),
    base: () => {
      const base: ElementBase = {
        name,
        left: c.num(e.left, `${path}.left`, 'finite') ?? 0,
        top: c.num(e.top, `${path}.top`, 'finite') ?? 0,
        width: c.num(e.width, `${path}.width`, 'nonNegative') ?? 0,
        height: c.num(e.height, `${path}.height`, 'nonNegative') ?? 0,
        visible: c.bool(e.visible, `${path}.visible`) ?? true,
      };
      setDefined(base, 'script', c.optStr(e.script, `${path}.script`));
      return base;
    },
  });
};

const checkPage = (c: Checker, value: unknown, path: string): Page => {
  const p = c.obj(value, path) ?? {};
  c.names.clear();
  // Keep each Element's list index so issues name the right path.
  const checked = (c.arr(p.elements, `${path}.elements`) ?? []).flatMap(
    (raw, i) => {
      const element = checkElement(c, raw, `${path}.elements[${i}]`);
      return element ? [{ element, i }] : [];
    },
  );
  c.unique(
    checked.map(({ element }) => element),
    n => `${path}.elements[${checked[n]!.i}]`,
    'Element on this Page',
  );
  const page: Page = {
    name: c.name(p.name, `${path}.name`) ?? '',
    height: c.num(p.height, `${path}.height`, 'positive') ?? 1,
    background: c.str(p.background, `${path}.background`) ?? '',
    elements: checked.map(({ element }) => element),
  };
  setDefined(page, 'script', c.optStr(p.script, `${path}.script`));
  for (const [key, valid, prose] of [
    ['alignX', isPageAlignX, 'left, center or right'],
    ['alignY', isPageAlignY, 'top, center or bottom'],
  ] as const) {
    const align = c.optStr(p[key], `${path}.${key}`);
    if (align !== undefined && !valid(align)) {
      c.fail(`${path}.${key}`, `expected ${prose}`);
    } else if (align !== undefined && align !== 'center') {
      page[key] = align as never;
    }
  }
  return page;
};

/** A Palette: a Page's fields, then its window's title, width and opening. */
const checkPalette = (c: Checker, value: unknown, path: string): Page => {
  const page = checkPage(c, value, path);
  const p = c.obj(value, path) ?? {};
  const openOnPlay = p.openOnPlay;
  if (typeof openOnPlay !== 'boolean') {
    c.fail(`${path}.openOnPlay`, 'expected true or false');
  }
  page.palette = {
    width: c.num(p.width, `${path}.width`, 'positive') ?? 1,
    openOnPlay: openOnPlay === true,
  };
  setDefined(page.palette, 'title', c.optStr(p.title, `${path}.title`));
  return page;
};

const checkAsset = (c: Checker, value: unknown, path: string): Asset => {
  const a = c.obj(value, path) ?? {};
  const hash = c.str(a.hash, `${path}.hash`) ?? '';
  if (hash && !/^[0-9a-f]{64}$/u.test(hash)) {
    c.fail(`${path}.hash`, 'expected a lowercase hex SHA-256');
  }
  const size = c.num(a.size, `${path}.size`, 'nonNegative') ?? 0;
  if (!Number.isInteger(size)) {
    c.fail(`${path}.size`, 'expected a whole number of bytes');
  }
  return {
    name: c.str(a.name, `${path}.name`) ?? '',
    hash,
    mediaType: c.str(a.mediaType, `${path}.mediaType`) ?? '',
    size,
    fileName: c.str(a.fileName, `${path}.fileName`) ?? '',
  };
};

/**
 * An Instrument's fields. A parameter its kind has gained since the file was
 * saved takes its default; the registry checks the rest.
 */
const checkInstrument = (
  c: Checker,
  raw: unknown,
  path: string,
): Instrument => {
  const instrument = c.obj(raw, path) ?? {};
  const kind = c.str(instrument.kind, `${path}.kind`) ?? '';
  const saved = isObj(instrument.parameters) ? instrument.parameters : {};
  if (!isObj(instrument.parameters)) {
    c.fail(`${path}.parameters`, 'expected an object');
  }
  const addOn = splitAddOnKind(kind)?.addOn;
  if (addOn && !c.addOns.has(addOn)) {
    c.fail(`${path}.kind`, `the Add-on ${addOn} is not in addOns`);
  }
  const definition = INSTRUMENT_KINDS.get(kind);
  return {
    name: c.str(instrument.name, `${path}.name`) ?? '',
    kind,
    voices: c.num(instrument.voices, `${path}.voices`, 'positive') ?? 1,
    parameters: {
      ...(definition ? defaultParameters(definition) : {}),
      ...(saved as Instrument['parameters']),
    },
  };
};

const VERSION = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.+-]+)?$/u;

/** One `addOns` entry: a URL, a version, and a Project Add-on's code. */
const checkAddOn = (c: Checker, raw: unknown, path: string): AddOnRef => {
  const a = c.obj(raw, path) ?? {};
  const id = c.str(a.id, `${path}.id`) ?? '';
  const idProblem = typeof a.id === 'string' ? addOnIdProblem(id) : undefined;
  if (idProblem) {
    c.fail(`${path}.id`, idProblem);
  }
  const version = c.str(a.version, `${path}.version`) ?? '';
  if (typeof a.version === 'string' && !VERSION.test(version)) {
    c.fail(`${path}.version`, 'expected a version such as 1.2.0');
  }
  const ref: AddOnRef = { id, version };
  const code = c.optStr(a.code, `${path}.code`);
  const hash = c.optStr(a.hash, `${path}.hash`);
  if ((code === undefined) !== (hash === undefined)) {
    c.fail(path, 'a Project Add-on needs both code and hash');
  }
  if (hash !== undefined && !/^[0-9a-f]{64}$/u.test(hash)) {
    c.fail(`${path}.hash`, 'expected a lowercase hex SHA-256');
  }
  setDefined(ref, 'code', code);
  setDefined(ref, 'hash', hash);
  return ref;
};

/**
 * Checks parsed `project.json` data (already migrated to the current
 * format). Returns the Project, or every problem found, each with the
 * path of the value at fault such as `pages[2].elements[5].left`.
 */
export const validateProjectJson = (
  data: unknown,
): { project: Project } | { issues: ValidationIssue[] } => {
  const c = new Checker();
  const root = c.obj(data, 'project.json') ?? {};
  // Read first: an Element of an Add-on's kind must name a listed Add-on.
  const addOns =
    root.addOns === undefined
      ? []
      : (c.arr(root.addOns, 'addOns') ?? []).map((raw, i) =>
          checkAddOn(c, raw, `addOns[${i}]`),
        );
  for (const [i, a] of addOns.entries()) {
    if (c.addOns.has(a.id)) {
      c.fail(`addOns[${i}].id`, 'another Add-on has this URL');
    }
    c.addOns.add(a.id);
  }
  const pages = (c.arr(root.pages, 'pages') ?? []).map((raw, i) =>
    checkPage(c, raw, `pages[${i}]`),
  );
  const palettes =
    root.palettes === undefined
      ? []
      : (c.arr(root.palettes, 'palettes') ?? []).map((raw, i) =>
          checkPalette(c, raw, `palettes[${i}]`),
        );
  // Pages and Palettes share one namespace in Scripts.
  c.unique(
    [...pages, ...palettes],
    i => (i < pages.length ? `pages[${i}]` : `palettes[${i - pages.length}]`),
    palettes.length ? 'Page or Palette' : 'Page',
  );
  const assets = (c.arr(root.assets, 'assets') ?? []).map((raw, i) =>
    checkAsset(c, raw, `assets[${i}]`),
  );
  c.unique(assets, i => `assets[${i}]`, 'asset');
  const libraries = (c.arr(root.libraries, 'libraries') ?? []).map((raw, i) => {
    const path = `libraries[${i}]`;
    const library = c.obj(raw, path) ?? {};
    const name = c.str(library.name, `${path}.name`) ?? '';
    return { name, source: c.str(library.source, `${path}.source`) ?? '' };
  });
  c.unique(libraries, i => `libraries[${i}]`, 'Library');
  const testScripts = (c.arr(root.testScripts, 'testScripts') ?? []).map(
    (raw, i) => {
      const path = `testScripts[${i}]`;
      const script = c.obj(raw, path) ?? {};
      const name = c.str(script.name, `${path}.name`) ?? '';
      const problem = testScriptNameProblem(name);
      if (problem && typeof script.name === 'string') {
        c.fail(`${path}.name`, problem);
      }
      return { name, source: c.str(script.source, `${path}.source`) ?? '' };
    },
  );
  c.unique(testScripts, i => `testScripts[${i}]`, 'Test Script');
  const instruments = (c.arr(root.instruments, 'instruments') ?? []).map(
    (raw, i) => checkInstrument(c, raw, `instruments[${i}]`),
  );
  for (const issue of instrumentProblems(instruments)) {
    c.fail(issue.path, issue.message);
  }
  const project: Project = {
    name: c.str(root.name, 'name') ?? '',
    designWidth: c.num(root.designWidth, 'designWidth', 'positive') ?? 1,
    script: c.str(root.script, 'script') ?? '',
    pages: [...pages, ...palettes],
    assets,
    instruments,
    libraries,
    testScripts,
  };
  if (addOns.length) {
    project.addOns = addOns;
  }
  if (root.base !== undefined) {
    const base = c.obj(root.base, 'base') ?? {};
    const name = c.str(base.name, 'base.name');
    if (
      name !== undefined &&
      !(BASE_PROJECT_NAMES as readonly string[]).includes(name)
    ) {
      c.fail('base.name', `expected one of ${BASE_PROJECT_NAMES.join(', ')}`);
    }
    const version = c.num(base.version, 'base.version', 'positive');
    if (version !== undefined && !Number.isInteger(version)) {
      c.fail('base.version', 'expected a whole number');
    }
    project.base = { name: name as BaseProjectName, version: version ?? 1 };
  }
  if (project.name === '' && typeof root.name === 'string') {
    c.fail('name', 'the Project needs a name');
  }
  return c.issues.length ? { issues: c.issues } : { project };
};

/** Checks an in-memory Project the same way reading a file does. */
export const validateProject = (
  project: DeepReadonly<Project>,
): ValidationIssue[] => {
  const result = validateProjectJson(serializeProject(project));
  return 'issues' in result ? result.issues : [];
};

// --- Serialization -----------------------------------------------------------

/**
 * The parsed-JSON form of a Project file's `project.json`. The model is
 * plain JSON data, so this is an independent copy plus the format header.
 */
// An Element still holding its saved form keeps it, even once its Add-on
// has loaded, until the Project is read again (#1901).
const savedElement = (element: Element): Obj =>
  ('saved' in element && element.saved !== undefined
    ? placeholderKind
    : kindOf(element)
  ).save?.(element as never, savedElement) ?? { ...element };
export const serializeProject = (project: DeepReadonly<Project>): Obj => {
  const copy = projectWithoutIds(project);
  const pages = copy.pages.filter(page => !page.palette);
  const palettes = copy.pages.flatMap(({ palette, ...page }) =>
    palette ? [{ ...page, ...palette }] : [],
  );
  return {
    format: CURRENT_FORMAT,
    app: APP,
    ...copy,
    pages: pages.map(page => ({
      ...page,
      elements: page.elements.map(savedElement),
    })),
    // Palettes are written after Pages, each with its settings inline.
    ...(palettes.length
      ? {
          palettes: palettes.map(page => ({
            ...page,
            elements: page.elements.map(savedElement),
          })),
        }
      : {}),
  };
};

/** The error for a damaged `project.json`, named by its first issue. */
const damaged = (issues: ValidationIssue[]): ProjectFileError => {
  const [first] = issues;
  return new ProjectFileError(
    `The Project inside this file is damaged at ${first!.path}: ${first!.message}.`,
    issues,
  );
};

// --- Migrations --------------------------------------------------------------

/** One format step: parsed JSON at format n in, format n + 1 out. */
export type Migration = (data: Obj) => Obj;

/** Format 1 is already a membership tree with only leaf roots. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {
  1: data => ({ ...data }),
  2: data => ({ ...data, libraries: [] }),
  3: data => ({ ...data, testScripts: [] }),
  4: migrateClicks,
  5: data => ({ ...data, instruments: [] }),
  6: migrateSounds,
  // Format 8 adds the optional `base`; older Projects have none.
  7: data => ({ ...data }),
  // Format 9 adds the optional `addOns` (ADR 0162); older Projects use none.
  8: data => ({ ...data }),
  // Format 10 moves the synth and YM2149 into the Instruments Add-on.
  9: migrateInstrumentKinds,
  // Format 11 adds the optional `palettes` (#1903); older Projects have none.
  10: data => ({ ...data }),
};

/**
 * Brings parsed `project.json` data to the current format, one step at a
 * time. Refuses a newer format rather than dropping fields it cannot know.
 */
export const migrateProjectJson = (
  data: unknown,
  migrations: Readonly<Record<number, Migration>> = MIGRATIONS,
  currentFormat: number = CURRENT_FORMAT,
): Obj => {
  if (!isObj(data)) {
    throw damaged([{ path: 'project.json', message: 'expected an object' }]);
  }
  const format = data.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    throw damaged([
      { path: 'format', message: 'expected a positive whole number' },
    ]);
  }
  if (format > currentFormat) {
    throw new ProjectFileError(
      `This Project was made with a newer version of the app (format ${format}; this app reads up to ${currentFormat}). Reload to update.`,
    );
  }
  let out = data;
  for (let n = format; n < currentFormat; n++) {
    const step = migrations[n];
    if (!step) {
      throw new ProjectFileError(
        `This app cannot upgrade a Project from format ${n}.`,
      );
    }
    out = { ...step(out), format: n + 1 };
  }
  return out;
};

// --- Reading and writing the file -------------------------------------------

export type ReadProject = {
  /** Asset bytes by SHA-256 hash, for every asset whose file was present. */
  assets: Map<string, Uint8Array>;
  /** Assets in the table whose file is missing; they open as placeholders. */
  missingAssets: Asset[];
  project: Project;
};

/** Whether `bytes` are the asset's: its size and its SHA-256. */
const bytesMatch = async (asset: Asset, bytes: Uint8Array): Promise<boolean> =>
  bytes.length === asset.size && (await sha256Hex(bytes)) === asset.hash;

/**
 * Writes a Project and its asset bytes (by hash) as a Project file.
 * Bytes the asset table does not name are dropped from the export.
 */
export const writeProjectFile = async (
  project: DeepReadonly<Project>,
  assetBytes: ReadonlyMap<string, Uint8Array>,
  { allowMissing = false }: { allowMissing?: boolean } = {},
): Promise<Uint8Array> => {
  const result = validateProjectJson(serializeProject(project));
  if ('issues' in result) {
    throw new ProjectFileError(
      `This Project cannot be written: ${result.issues.map(i => `${i.path}: ${i.message}`).join('; ')}.`,
      result.issues,
    );
  }
  // One zip entry per hash, reported at its first asset-table row.
  const seen = new Set<string>();
  const toWrite = [...project.assets.entries()].filter(
    ([, asset]) => !seen.has(asset.hash) && seen.add(asset.hash),
  );
  const checks = await Promise.all(
    toWrite.map(([, asset]) => {
      const bytes = assetBytes.get(asset.hash);
      return bytes ? bytesMatch(asset, bytes) : false;
    }),
  );
  const entries: ZipEntry[] = [
    { name: 'mimetype', data: new TextEncoder().encode(PROJECT_MIMETYPE) },
    {
      name: 'project.json',
      data: new TextEncoder().encode(
        JSON.stringify(serializeProject(result.project), null, 2),
      ),
      method: 8,
    },
  ];
  for (const [n, [i, asset]] of toWrite.entries()) {
    const bytes = assetBytes.get(asset.hash);
    if (!bytes) {
      if (allowMissing) {
        continue;
      }
      throw new ProjectFileError(
        `The asset "${asset.name}" has no bytes to write.`,
        [{ path: `assets[${i}].hash`, message: 'no bytes for this hash' }],
      );
    }
    if (!checks[n]) {
      throw new ProjectFileError(
        `The bytes for the asset "${asset.name}" do not match its hash and size.`,
        [{ path: `assets[${i}].hash`, message: 'bytes do not match the hash' }],
      );
    }
    entries.push({ name: assetEntryName(asset), data: bytes });
  }
  try {
    return await writeZip(entries);
  } catch (error) {
    throw error instanceof ZipError
      ? new ProjectFileError(error.message)
      : error;
  }
};

/** The hash an `assets/<sha256>[.<ext>]` entry name stores, if it is one. */
const ASSET_ENTRY = /^assets\/([0-9a-f]{64})(?:\.[^/]*)?$/u;

/**
 * Reads a Project file. Any damage — a corrupt zip, a CRC mismatch,
 * damaged JSON, a newer format — is an error; nothing is half-read.
 */
export const readProjectFile = async (
  bytes: Uint8Array,
): Promise<ReadProject> => {
  let entries: Map<string, Uint8Array>;
  try {
    entries = await readZip(bytes);
  } catch (error) {
    throw error instanceof ZipError
      ? new ProjectFileError(
          `This file isn't a complete Project file. ${error.message}`,
        )
      : error;
  }
  const mimetype = entries.get('mimetype');
  if (
    mimetype &&
    new TextDecoder().decode(mimetype).trim() !== PROJECT_MIMETYPE
  ) {
    throw new ProjectFileError('This file is not a Project file.');
  }
  const jsonBytes = entries.get('project.json');
  if (!jsonBytes) {
    throw new ProjectFileError(
      'This file is not a Project file: it has no project.json.',
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(new TextDecoder().decode(jsonBytes));
  } catch {
    throw damaged([{ path: 'project.json', message: 'not valid JSON' }]);
  }
  const result = validateProjectJson(migrateProjectJson(data));
  if ('issues' in result) {
    throw damaged(result.issues);
  }
  const { project } = result;
  for (const addOn of project.addOns ?? []) {
    if (
      addOn.code !== undefined &&
      (await sha256Hex(new TextEncoder().encode(addOn.code))) !== addOn.hash
    ) {
      throw new ProjectFileError(
        `The code for the Add-on ${addOn.id} does not match its hash.`,
      );
    }
  }
  const filesByHash = new Map<string, Uint8Array>();
  for (const [name, data] of entries) {
    const hash = ASSET_ENTRY.exec(name)?.[1];
    if (hash) {
      filesByHash.set(hash, data);
    }
  }
  const present = [
    ...new Map(project.assets.map(a => [a.hash, a])).values(),
  ].filter(a => filesByHash.has(a.hash));
  const checks = await Promise.all(
    present.map(a => bytesMatch(a, filesByHash.get(a.hash)!)),
  );
  const mismatch = present.find((_, n) => !checks[n]);
  if (mismatch) {
    throw new ProjectFileError(
      `The file for the asset "${mismatch.name}" does not match its hash and size.`,
    );
  }
  return {
    project,
    assets: new Map(present.map(a => [a.hash, filesByHash.get(a.hash)!])),
    missingAssets: project.assets.filter(a => !filesByHash.has(a.hash)),
  };
};
