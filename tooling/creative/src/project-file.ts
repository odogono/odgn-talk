// The Project file format (#748; layout from #739): a zip holding a
// `mimetype` entry first, a deflated `project.json` with an integer
// `format` version, and one stored `assets/<sha256>.<ext>` per asset.
// Files hold the authored Project only, never Play State (ADR 0041).

import {
  ELEMENT_KINDS,
  isIdentifierName,
  type Asset,
  type Element,
  type ElementKind,
  type Page,
  type Project,
  type RichText,
} from './model';
import { readZip, writeZip, ZipError, type ZipEntry } from './zip';

export const PROJECT_MIMETYPE = 'application/vnd.odgn.northtalk-project+zip';
export const CURRENT_FORMAT = 1;
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

class Checker {
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
    return {
      runs: runs.map((rawRun, j) => {
        const at = `${path}[${i}].runs[${j}]`;
        const r = c.obj(rawRun, at) ?? {};
        const run: RichText[number]['runs'][number] = {
          text: c.str(r.text, `${at}.text`) ?? '',
        };
        const bold = c.optBool(r.bold, `${at}.bold`);
        const italic = c.optBool(r.italic, `${at}.italic`);
        const underline = c.optBool(r.underline, `${at}.underline`);
        const color = c.optStr(r.color, `${at}.color`);
        if (bold !== undefined) {
          run.bold = bold;
        }
        if (italic !== undefined) {
          run.italic = italic;
        }
        if (underline !== undefined) {
          run.underline = underline;
        }
        if (color !== undefined) {
          run.color = color;
        }
        return run;
      }),
    };
  });
};

const checkElement = (
  c: Checker,
  value: unknown,
  path: string,
): Element | undefined => {
  const e = c.obj(value, path);
  if (!e) {
    return undefined;
  }
  const kind = e.kind;
  if (
    typeof kind !== 'string' ||
    !(ELEMENT_KINDS as readonly string[]).includes(kind)
  ) {
    c.fail(`${path}.kind`, `unknown Element kind ${JSON.stringify(kind)}`);
    return undefined;
  }
  const base = {
    name: c.name(e.name, `${path}.name`) ?? '',
    left: c.num(e.left, `${path}.left`, 'finite') ?? 0,
    top: c.num(e.top, `${path}.top`, 'finite') ?? 0,
    width: c.num(e.width, `${path}.width`, 'nonNegative') ?? 0,
    height: c.num(e.height, `${path}.height`, 'nonNegative') ?? 0,
    visible: c.bool(e.visible, `${path}.visible`) ?? true,
  };
  const script = c.optStr(e.script, `${path}.script`);
  if (script !== undefined) {
    Object.assign(base, { script });
  }
  const k = kind as ElementKind;
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
  const elements: Element[] = [];
  const seen = new Set<string>();
  (c.arr(p.elements, `${path}.elements`) ?? []).forEach((raw, i) => {
    const element = checkElement(c, raw, `${path}.elements[${i}]`);
    if (!element) {
      return;
    }
    if (seen.has(element.name)) {
      c.fail(
        `${path}.elements[${i}].name`,
        `another Element on this Page is also named "${element.name}"`,
      );
    }
    seen.add(element.name);
    elements.push(element);
  });
  const page: Page = {
    name: c.name(p.name, `${path}.name`) ?? '',
    height: c.num(p.height, `${path}.height`, 'positive') ?? 1,
    background: c.str(p.background, `${path}.background`) ?? '',
    elements,
  };
  const script = c.optStr(p.script, `${path}.script`);
  if (script !== undefined) {
    page.script = script;
  }
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
  const pages: Page[] = [];
  const pageNames = new Set<string>();
  (c.arr(root.pages, 'pages') ?? []).forEach((raw, i) => {
    const page = checkPage(c, raw, `pages[${i}]`);
    if (pageNames.has(page.name)) {
      c.fail(`pages[${i}].name`, `another Page is also named "${page.name}"`);
    }
    pageNames.add(page.name);
    pages.push(page);
  });
  const assets: Asset[] = [];
  const assetNames = new Set<string>();
  (c.arr(root.assets, 'assets') ?? []).forEach((raw, i) => {
    const asset = checkAsset(c, raw, `assets[${i}]`);
    if (assetNames.has(asset.name)) {
      c.fail(
        `assets[${i}].name`,
        `another asset is also named "${asset.name}"`,
      );
    }
    assetNames.add(asset.name);
    assets.push(asset);
  });
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
export const validateProject = (project: Project): ValidationIssue[] => {
  const result = validateProjectJson(projectToJson(project));
  return 'issues' in result ? result.issues : [];
};

// --- Serialization -----------------------------------------------------------

const elementToJson = (e: Element): Obj => {
  const base: Obj = {
    kind: e.kind,
    name: e.name,
    left: e.left,
    top: e.top,
    width: e.width,
    height: e.height,
    visible: e.visible,
  };
  if (e.script !== undefined) {
    base.script = e.script;
  }
  switch (e.kind) {
    case 'text':
      return {
        ...base,
        richText: e.richText,
        textColor: e.textColor,
        textSize: e.textSize,
        font: e.font,
        editable: e.editable,
      };
    case 'image':
      return { ...base, image: e.image };
    case 'button':
      return { ...base, label: e.label, fill: e.fill, textColor: e.textColor };
    case 'rectangle':
    case 'ellipse':
      return { ...base, fill: e.fill, stroke: e.stroke };
    case 'line':
      return { ...base, stroke: e.stroke, thickness: e.thickness };
  }
};

const projectToJson = (project: Project): Obj => ({
  name: project.name,
  designWidth: project.designWidth,
  script: project.script,
  pages: project.pages.map(p => {
    const page: Obj = {
      name: p.name,
      height: p.height,
      background: p.background,
      elements: p.elements.map(elementToJson),
    };
    if (p.script !== undefined) {
      page.script = p.script;
    }
    return page;
  }),
  assets: project.assets.map(a => ({ ...a })),
});

/** The parsed-JSON form of a Project file's `project.json`. */
export const serializeProject = (project: Project): Obj => ({
  format: CURRENT_FORMAT,
  app: APP,
  ...projectToJson(project),
});

// --- Migrations --------------------------------------------------------------

/** One format step: parsed JSON at format n in, format n + 1 out. */
export type Migration = (data: Obj) => Obj;

/** Migrations by the format they upgrade from. Empty while format is 1. */
export const MIGRATIONS: Readonly<Record<number, Migration>> = {};

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
    throw new ProjectFileError(
      'The Project inside this file is damaged at project.json: expected an object.',
      [{ path: 'project.json', message: 'expected an object' }],
    );
  }
  const format = data.format;
  if (typeof format !== 'number' || !Number.isInteger(format) || format < 1) {
    throw new ProjectFileError(
      'The Project inside this file is damaged at format: expected a positive whole number.',
      [{ path: 'format', message: 'expected a positive whole number' }],
    );
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

/**
 * Writes a Project and its asset bytes (by hash) as a Project file.
 * Bytes the asset table does not name are dropped from the export.
 */
export const writeProjectFile = async (
  project: Project,
  assetBytes: ReadonlyMap<string, Uint8Array>,
): Promise<Uint8Array> => {
  const issues = validateProject(project);
  if (issues.length) {
    throw new ProjectFileError(
      `This Project cannot be written: ${issues.map(i => `${i.path}: ${i.message}`).join('; ')}.`,
      issues,
    );
  }
  const entries: ZipEntry[] = [
    { name: 'mimetype', data: new TextEncoder().encode(PROJECT_MIMETYPE) },
    {
      name: 'project.json',
      data: new TextEncoder().encode(
        JSON.stringify(serializeProject(project), null, 2),
      ),
      method: 8,
    },
  ];
  const written = new Set<string>();
  for (const [i, asset] of project.assets.entries()) {
    if (written.has(asset.hash)) {
      continue;
    }
    written.add(asset.hash);
    const bytes = assetBytes.get(asset.hash);
    if (!bytes) {
      throw new ProjectFileError(
        `The asset "${asset.name}" has no bytes to write.`,
        [{ path: `assets[${i}].hash`, message: 'no bytes for this hash' }],
      );
    }
    if (
      bytes.length !== asset.size ||
      (await sha256Hex(bytes)) !== asset.hash
    ) {
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
    throw new ProjectFileError(
      'The Project inside this file is damaged at project.json: it is not valid JSON.',
      [{ path: 'project.json', message: 'not valid JSON' }],
    );
  }
  const migrated = migrateProjectJson(data);
  const result = validateProjectJson(migrated);
  if ('issues' in result) {
    const first = result.issues[0]!;
    throw new ProjectFileError(
      `The Project inside this file is damaged at ${first.path}: ${first.message}.`,
      result.issues,
    );
  }
  const { project } = result;
  const assets = new Map<string, Uint8Array>();
  const missingAssets: Asset[] = [];
  for (const asset of project.assets) {
    if (assets.has(asset.hash)) {
      continue;
    }
    const entry = [...entries.keys()].find(
      name =>
        name.startsWith(`assets/${asset.hash}.`) ||
        name === `assets/${asset.hash}`,
    );
    const data = entry ? entries.get(entry) : undefined;
    if (!data) {
      missingAssets.push(asset);
      continue;
    }
    if (data.length !== asset.size || (await sha256Hex(data)) !== asset.hash) {
      throw new ProjectFileError(
        `The file for the asset "${asset.name}" does not match its hash and size.`,
      );
    }
    assets.set(asset.hash, data);
  }
  return { project, assets, missingAssets };
};
