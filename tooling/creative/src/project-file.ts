// The Project file format (#748; layout from #739): a zip holding a
// `mimetype` entry first, a deflated `project.json` with an integer
// `format` version, and one stored `assets/<sha256>.<ext>` per asset.
// Files hold the authored Project only, never Play State (ADR 0041).
import { type Immutable } from 'immer';
import { checkHierarchy, refreshBounds, MAX_GROUP_DEPTH } from './tree/rules';

import {
  alignParagraph,
  ELEMENT_KINDS,
  isIdentifierName,
  isTextAlign,
  projectWithoutIds,
  type Asset,
  type Element,
  type ElementKind,
  type Page,
  type Paragraph,
  type Project,
  type RichText,
  type TextRun,
} from './model';
import { readZip, writeZip, ZipError, type ZipEntry } from './zip';

export const PROJECT_MIMETYPE = 'application/vnd.odgn.northtalk-project+zip';
export const CURRENT_FORMAT = 2;
const APP = 'northtalk-creative';

export type ValidationIssue = { message: string; path: string };

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

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Copies an optional field onto `target` only when it is present. */
const setDefined = <T extends object, K extends keyof T>(
  target: T,
  key: K,
  value: T[K] | undefined,
): void => {
  if (value !== undefined) {
    target[key] = value;
  }
};

class Checker {
  readonly elements = new Set<object>();
  readonly names = new Set<string>();
  readonly issues: ValidationIssue[] = [];

  fail(path: string, message: string): void {
    this.issues.push({ path, message });
  }

  obj(value: unknown, path: string): Obj | undefined {
    if (!isObj(value)) {
      this.fail(path, 'expected an object');
      return undefined;
    }
    return value;
  }

  arr(value: unknown, path: string): unknown[] | undefined {
    if (!Array.isArray(value)) {
      this.fail(path, 'expected a list');
      return undefined;
    }
    return value;
  }

  str(value: unknown, path: string): string | undefined {
    if (typeof value !== 'string') {
      this.fail(path, 'expected text');
      return undefined;
    }
    return value;
  }

  optStr(value: unknown, path: string): string | undefined {
    return value === undefined ? undefined : this.str(value, path);
  }

  bool(value: unknown, path: string): boolean | undefined {
    if (typeof value !== 'boolean') {
      this.fail(path, 'expected true or false');
      return undefined;
    }
    return value;
  }

  optBool(value: unknown, path: string): boolean | undefined {
    return value === undefined ? undefined : this.bool(value, path);
  }

  num(
    value: unknown,
    path: string,
    rule: 'finite' | 'nonNegative' | 'positive',
  ): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      this.fail(path, 'expected a number');
      return undefined;
    }
    if (rule === 'positive' && value <= 0) {
      this.fail(path, 'expected a number above zero');
      return undefined;
    }
    if (rule === 'nonNegative' && value < 0) {
      this.fail(path, 'expected zero or above');
      return undefined;
    }
    return value;
  }

  /** Reports every item whose `name` repeats an earlier one in its list. */
  unique(
    items: readonly { name: string }[],
    pathOf: (i: number) => string,
    noun: string,
  ): void {
    const seen = new Set<string>();
    items.forEach(({ name }, i) => {
      if (seen.has(name)) {
        this.fail(
          `${pathOf(i)}.name`,
          `another ${noun} is also named "${name}"`,
        );
      }
      seen.add(name);
    });
  }

  name(value: unknown, path: string): string | undefined {
    const name = this.str(value, path);
    if (name !== undefined && !isIdentifierName(name)) {
      this.fail(path, `"${name}" is not an identifier name`);
      return undefined;
    }
    return name;
  }
}

// The builders below run even after a failure, so one read reports every
// problem. Their placeholder values are discarded whenever issues exist.

const checkRichText = (c: Checker, value: unknown, path: string): RichText => {
  const paragraphs = c.arr(value, path) ?? [];
  return paragraphs.map((raw, i) => {
    const p = c.obj(raw, `${path}[${i}]`) ?? {};
    const runs = c.arr(p.runs, `${path}[${i}].runs`) ?? [];
    const align = c.optStr(p.align, `${path}[${i}].align`);
    if (align !== undefined && !isTextAlign(align)) {
      c.fail(`${path}[${i}].align`, 'expected left, center, right or justify');
    }
    const paragraph: Paragraph = {
      runs: runs.map((rawRun, j) => {
        const at = `${path}[${i}].runs[${j}]`;
        const r = c.obj(rawRun, at) ?? {};
        const run: TextRun = {
          text: c.str(r.text, `${at}.text`) ?? '',
        };
        for (const key of ['bold', 'italic', 'underline'] as const) {
          setDefined(run, key, c.optBool(r[key], `${at}.${key}`));
        }
        setDefined(run, 'color', c.optStr(r.color, `${at}.color`));
        return run;
      }),
    };
    alignParagraph(paragraph, isTextAlign(align) ? align : undefined);
    return paragraph;
  });
};

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
  if (e.kind === 'group') {
    if (depth >= MAX_GROUP_DEPTH) {
      c.fail(path, `groups may nest at most ${MAX_GROUP_DEPTH} levels`);
      return undefined;
    }
    const members = (c.arr(e.members, `${path}.members`) ?? []).flatMap(
      (raw, i) => {
        const member = checkElement(c, raw, `${path}.members[${i}]`, depth + 1);
        return member ? [member] : [];
      },
    );
    const anchor = members.length
      ? undefined
      : c.obj(
          e.emptyPosition ??
            (typeof e.left === 'number'
              ? { left: e.left, top: e.top }
              : undefined),
          `${path}.emptyPosition`,
        );
    if (members.length && e.emptyPosition !== undefined) {
      c.fail(
        `${path}.emptyPosition`,
        'only empty groups have a saved position',
      );
    }
    const group: Element = {
      kind: 'group',
      name,
      members,
      visible: c.bool(e.visible, `${path}.visible`) ?? true,
      left: anchor
        ? (c.num(anchor.left, `${path}.emptyPosition.left`, 'finite') ?? 0)
        : 0,
      top: anchor
        ? (c.num(anchor.top, `${path}.emptyPosition.top`, 'finite') ?? 0)
        : 0,
      width: 0,
      height: 0,
    };
    setDefined(group, 'script', c.optStr(e.script, `${path}.script`));
    try {
      checkHierarchy([group]);
      refreshBounds([group]);
    } catch (error) {
      c.fail(path, error instanceof Error ? error.message : String(error));
    }
    return group;
  }
  const k = e.kind as ElementKind;
  if (!ELEMENT_KINDS.includes(k)) {
    c.fail(`${path}.kind`, `unknown Element kind ${JSON.stringify(e.kind)}`);
    return undefined;
  }
  const base: Omit<Element, 'kind'> = {
    name,
    left: c.num(e.left, `${path}.left`, 'finite') ?? 0,
    top: c.num(e.top, `${path}.top`, 'finite') ?? 0,
    width: c.num(e.width, `${path}.width`, 'nonNegative') ?? 0,
    height: c.num(e.height, `${path}.height`, 'nonNegative') ?? 0,
    visible: c.bool(e.visible, `${path}.visible`) ?? true,
  };
  setDefined(base, 'script', c.optStr(e.script, `${path}.script`));
  switch (k) {
    case 'text':
      return {
        ...base,
        kind: k,
        richText: checkRichText(c, e.richText, `${path}.richText`),
        textColor: c.str(e.textColor, `${path}.textColor`) ?? '',
        textSize: c.num(e.textSize, `${path}.textSize`, 'positive') ?? 1,
        font: c.str(e.font, `${path}.font`) ?? '',
        editable: c.bool(e.editable, `${path}.editable`) ?? false,
      };
    case 'image':
      return { ...base, kind: k, image: c.str(e.image, `${path}.image`) ?? '' };
    case 'button':
      return {
        ...base,
        kind: k,
        label: c.str(e.label, `${path}.label`) ?? '',
        fill: c.str(e.fill, `${path}.fill`) ?? '',
        textColor: c.str(e.textColor, `${path}.textColor`) ?? '',
      };
    case 'rectangle':
    case 'ellipse':
      return {
        ...base,
        kind: k,
        fill: c.str(e.fill, `${path}.fill`) ?? '',
        stroke: c.str(e.stroke, `${path}.stroke`) ?? '',
        // Older format-1 Projects used a fixed 2px border.
        thickness:
          e.thickness === undefined
            ? 2
            : (c.num(e.thickness, `${path}.thickness`, 'nonNegative') ?? 2),
      };
    case 'line':
      return {
        ...base,
        kind: k,
        stroke: c.str(e.stroke, `${path}.stroke`) ?? '',
        thickness: c.num(e.thickness, `${path}.thickness`, 'positive') ?? 1,
      };
  }
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
 * Checks parsed `project.json` data (already migrated to the current
 * format). Returns the Project, or every problem found, each with the
 * path of the value at fault such as `pages[2].elements[5].left`.
 */
export const validateProjectJson = (
  data: unknown,
): { project: Project } | { issues: ValidationIssue[] } => {
  const c = new Checker();
  const root = c.obj(data, 'project.json') ?? {};
  const pages = (c.arr(root.pages, 'pages') ?? []).map((raw, i) =>
    checkPage(c, raw, `pages[${i}]`),
  );
  c.unique(pages, i => `pages[${i}]`, 'Page');
  const assets = (c.arr(root.assets, 'assets') ?? []).map((raw, i) =>
    checkAsset(c, raw, `assets[${i}]`),
  );
  c.unique(assets, i => `assets[${i}]`, 'asset');
  const project: Project = {
    name: c.str(root.name, 'name') ?? '',
    designWidth: c.num(root.designWidth, 'designWidth', 'positive') ?? 1,
    script: c.str(root.script, 'script') ?? '',
    pages,
    assets,
  };
  if (project.name === '' && typeof root.name === 'string') {
    c.fail('name', 'the Project needs a name');
  }
  return c.issues.length ? { issues: c.issues } : { project };
};

/** Checks an in-memory Project the same way reading a file does. */
export const validateProject = (
  project: Immutable<Project>,
): ValidationIssue[] => {
  const result = validateProjectJson(project);
  return 'issues' in result ? result.issues : [];
};

// --- Serialization -----------------------------------------------------------

/**
 * The parsed-JSON form of a Project file's `project.json`. The model is
 * plain JSON data, so this is an independent copy plus the format header.
 */
const savedElement = (element: Element): Obj => {
  if (element.kind !== 'group') {
    return { ...element };
  }
  return {
    kind: 'group',
    name: element.name,
    visible: element.visible,
    ...(element.script === undefined ? {} : { script: element.script }),
    members: element.members.map(savedElement),
    ...(element.members.length
      ? {}
      : { emptyPosition: { left: element.left, top: element.top } }),
  };
};
export const serializeProject = (project: Immutable<Project>): Obj => {
  const copy = projectWithoutIds(project);
  return {
    format: CURRENT_FORMAT,
    app: APP,
    ...copy,
    pages: copy.pages.map(page => ({
      ...page,
      elements: page.elements.map(savedElement),
    })),
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
  project: Immutable<Project>,
  assetBytes: ReadonlyMap<string, Uint8Array>,
  { allowMissing = false }: { allowMissing?: boolean } = {},
): Promise<Uint8Array> => {
  const result = validateProjectJson(project);
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
