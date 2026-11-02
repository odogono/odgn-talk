// Element kinds from Add-ons (ADR 0162). A kind is named by its Add-on's URL
// and `#<name>`. Until the Add-on loader (#1901) registers a kind, every
// Element of it is a placeholder: its box, name and Owning Script stay
// editable, and the rest of its data is written back unchanged.
import type { AddOnElement, AddOnKind, ElementKind } from '../model';
import type { Obj } from './checker';
import { commonProperties, defineElementKind } from './definition';

const KIND_NAME = /^[a-z][a-z0-9-]*$/u;

/** The Add-on URL problem in `id`, else undefined. */
export const addOnIdProblem = (id: string): string | undefined => {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return 'expected an Add-on URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return 'expected an http or https URL';
  }
  if (url.hash || id.includes('#')) {
    return 'an Add-on URL has no #fragment';
  }
  return url.href === id
    ? undefined
    : `expected the URL written as ${url.href}`;
};

/** Splits an Add-on kind into its Add-on's URL and the kind's name. */
export const splitAddOnKind = (
  kind: string,
): { addOn: string; name: string } | undefined => {
  const at = kind.lastIndexOf('#');
  if (at < 0) {
    return undefined;
  }
  const addOn = kind.slice(0, at);
  const name = kind.slice(at + 1);
  return addOnIdProblem(addOn) === undefined && KIND_NAME.test(name)
    ? { addOn, name }
    : undefined;
};

export const isAddOnKind = (kind: ElementKind | string): kind is AddOnKind =>
  splitAddOnKind(kind) !== undefined;

/** The error a Script gets when it uses a placeholder during Play. */
export const missingAddOn = (name: string, kind: AddOnKind): string => {
  const { addOn } = splitAddOnKind(kind)!;
  return `“${name}” needs the Add-on ${addOn}, which isn't loaded`;
};

/** The Object Kind Scripts see a placeholder as. */
export const PLACEHOLDER_OBJECT_KIND = 'placeholder';

/** The fields every Element has, which a placeholder keeps editable. */
const COMMON_FIELDS = [
  'name',
  'left',
  'top',
  'width',
  'height',
  'visible',
  'script',
] as const;

export const placeholderKind = defineElementKind<AddOnKind>({
  // Stands in for every Add-on kind; each Element keeps its own `kind`.
  kind: 'placeholder#placeholder' as AddOnKind,
  label: 'Missing Add-on',
  icon: '?',
  creatable: false,
  // Authors can move and resize one; Play refuses Scripts' reads and writes.
  properties: commonProperties,
  create: () => {
    throw new Error('A placeholder is only read from a file');
  },
  check: (c, e, path, { base, addOns }) => {
    const kind = e.kind as AddOnKind;
    const { addOn } = splitAddOnKind(kind)!;
    if (!addOns.has(addOn)) {
      c.fail(`${path}.kind`, `the Add-on ${addOn} is not in addOns`);
    }
    const saved: Obj = structuredClone(e);
    delete saved.id;
    return { ...base(), kind, saved } satisfies AddOnElement;
  },
  // The saved form, in its saved key order, with the common fields as now.
  save: element => {
    const out: Obj = { ...element.saved, kind: element.kind };
    for (const field of COMMON_FIELDS) {
      if (element[field] === undefined) {
        delete out[field];
      } else {
        out[field] = element[field];
      }
    }
    return out;
  },
  forPage: element => element,
});
