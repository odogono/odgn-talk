// One Element kind's definition (#1900): what Folio knows about a kind
// lives here, with what it draws and its Info controls in `views.tsx`, and
// code outside `elements/` asks the registry rather than branching on `kind`.
// Kinds from Add-ons (ADR 0162) register when their Add-on loads (#1901).
import type { CSSProperties } from 'preact';
import type {
  AddOnElement,
  AddOnKind,
  Element,
  ElementBase,
  ElementKind,
  Page,
  Project,
} from '../model';
import type { DeepReadonly } from '../readonly';
import { GEOMETRY_FUEL, PROPERTY_FUEL, type Box } from '../tree/rules';
import type { Checker, Obj } from './checker';

export type PropertyOwner = DeepReadonly<Project | Page | Element>;
export type PropertyValue = string | number | boolean;

/** Tree-owned publication keeps validation/staging separate from live writes. */
export type PropertyWriter = {
  field(field: string, value: unknown, knownDifferent?: boolean): void;
  geometry(changes: Partial<Box>): void;
  text(value: string): void;
};

/** One property: its shape, how it is read and written, and its checks. */
export type PropertyDescriptor = {
  get(owner: PropertyOwner): PropertyValue;
  /** The lowest number Info lets an author enter, when there is one. */
  infoMin?: number;
  /** Authoring-only fields are never part of a Script's Host interface. */
  script?: false;
  set?(
    owner: PropertyOwner,
    value: PropertyValue,
    writer: PropertyWriter,
  ): void;
  setCost?: { fuel: number };
  shape: 'text' | 'number' | 'boolean';
  validate?(owner: PropertyOwner, value: PropertyValue): string | undefined;
};

export const scalar = (
  field: string,
  shape: PropertyDescriptor['shape'],
): PropertyDescriptor => ({
  shape,
  get: owner => (owner as unknown as Record<string, PropertyValue>)[field]!,
  set: (_owner, value, writer) => writer.field(field, value),
});
/** Element writes cost Fuel; Project and Page writes are authoring-only. */
export const property = (
  field: string,
  shape: PropertyDescriptor['shape'],
): PropertyDescriptor => ({
  ...scalar(field, shape),
  setCost: { fuel: PROPERTY_FUEL },
});
export const readOnly = ({
  set: _set,
  setCost: _setCost,
  ...descriptor
}: PropertyDescriptor): PropertyDescriptor => descriptor;
const geometry = (field: keyof Box): PropertyDescriptor => ({
  ...scalar(field, 'number'),
  setCost: { fuel: GEOMETRY_FUEL },
  set: (_owner, value, writer) => writer.geometry({ [field]: Number(value) }),
});
export const nameProperty = readOnly(scalar('name', 'text'));
/** The properties every Element kind has. */
export const commonProperties = {
  name: nameProperty,
  left: geometry('left'),
  top: geometry('top'),
  width: geometry('width'),
  height: geometry('height'),
  visible: property('visible', 'boolean'),
};

type Of<K extends ElementKind> = K extends AddOnKind
  ? AddOnElement
  : Extract<Element, { kind: K }>;

/** What `check` is given besides the raw object. */
export type CheckContext = {
  /** The URLs of the Add-ons the Project lists. */
  addOns: ReadonlySet<string>;
  /** The common properties, read and checked; Groups derive their own. */
  base(): ElementBase;
  /** How deep in Groups this Element sits. */
  depth: number;
  /** Checks a member Element one level down. */
  member(raw: unknown, path: string): Element | undefined;
  name: string;
};

/** What Play's page adds to a kind's view for the reader. */
export type ReaderContext = { takesInput: boolean; visible: boolean };

export type ElementKindDefinition<K extends ElementKind = ElementKind> = {
  /** The asset it shows, by name, when it shows one. */
  asset?(element: DeepReadonly<Of<K>>): string;
  /**
   * The fields Info lets bind to an Instrument parameter or the tempo, or,
   * with `output`, the one field that shows an Instrument's output (#1904).
   */
  bindings?: { readonly fields: readonly string[]; readonly output?: true };
  /**
   * Reads one from a Project file, migrating older formats; reports problems
   * on `c` and still returns a placeholder so one read finds them all.
   */
  check(
    c: Checker,
    raw: Obj,
    path: string,
    context: CheckContext,
  ): Of<K> | undefined;
  /** Classes beyond `el <kind>`, each with a leading space. */
  className?(element: DeepReadonly<Of<K>>): string;
  /** It holds member Elements, which a Script reaches as its `elements`. */
  container?: true;
  /** Scripts and the Tools window can make one; Groups come from grouping. */
  creatable: boolean;
  /** A new one with the kind's defaults, at `base`. */
  create(base: ElementBase): Of<K>;
  /** It may be zero wide or high, as a line is. */
  flat?: true;
  /**
   * Its Play State as the worker sends it to the page: the parts that travel
   * separately, such as a Group's members, are left out.
   */
  forPage?(element: DeepReadonly<Of<K>>): Of<K>;
  /** The Tools window's glyph for it. */
  icon: string;
  kind: K;
  /** Its name in Info and the Tools window. */
  label: string;
  /** Its Host-facing properties: shapes, reads, writes and checks. */
  properties: Readonly<Record<string, PropertyDescriptor>>;
  /** Attributes Play's page gives it for reader input. */
  readerAttributes?(
    element: DeepReadonly<Of<K>>,
    context: ReaderContext,
  ): Record<string, unknown>;
  /** Its `project.json` form; the Element as it is by default. */
  save?(element: Of<K>, saveMember: (member: Element) => Obj): Obj;
  /** Its inline style beyond the box. */
  style?(element: DeepReadonly<Of<K>>): CSSProperties;
  /** The property an "Add action…" text recipe sets on it. */
  textProperty?: 'label' | 'text';
};

/** Checks a definition's shape against its kind. */
export const defineElementKind = <K extends ElementKind>(
  definition: ElementKindDefinition<K>,
): ElementKindDefinition<K> => definition;
