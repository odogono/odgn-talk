// What an Add-on module is and what Folio hands it (ADR 0162, #1901). An
// Add-on imports nothing from Folio at run time: its module's default export
// names it and gives, for each Element kind, a factory for the kind's data
// half, which the page, the Play worker and the CLI all load, and one for
// its view half, which only the page calls. Folio passes each factory its
// helpers and its own Preact, so a built-in Add-on and a Project Add-on see
// the same API and there is one Preact.
import type { ComponentChildren, FunctionComponent, h } from 'preact';
import type {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from 'preact/hooks';
import type { AddOnKind } from '../model';
import type { InfoControls } from '../elements/controls';
import type {
  ElementKindDefinition,
  commonProperties,
  property,
  readOnly,
  scalar,
} from '../elements/definition';
import type { ElementKindView } from '../elements/views';
import type { LiteralKind, LiteralState } from '../literal-editors';
import type { InstrumentKind } from '../instruments/kind';
import type {
  NOTE_OPERATIONS,
  SAMPLER_OPERATIONS,
} from '../instruments/operations';

/** The helpers an Add-on kind's data half is given. */
export type AddOnDataApi = {
  commonProperties: typeof commonProperties;
  property: typeof property;
  readOnly: typeof readOnly;
  scalar: typeof scalar;
};

/** What an Add-on kind's view half is given: Preact and Info's controls. */
export type AddOnViewApi = {
  controls: InfoControls;
  Fragment: FunctionComponent<{ children?: ComponentChildren }>;
  h: typeof h;
  hooks: {
    useEffect: typeof useEffect;
    useLayoutEffect: typeof useLayoutEffect;
    useRef: typeof useRef;
    useState: typeof useState;
  };
};

/** A kind's definition without its `kind`, which the loader fills in. */
export type AddOnKindData = Omit<ElementKindDefinition<AddOnKind>, 'kind'>;

export type AddOnKindModule = {
  data(api: AddOnDataApi): AddOnKindData;
  view?(api: AddOnViewApi): ElementKindView<AddOnKind>;
};

/** What an Add-on's Instrument kind is given: the shared Operations. */
export type AddOnInstrumentApi = {
  operations: {
    note: typeof NOTE_OPERATIONS;
    sampler: typeof SAMPLER_OPERATIONS;
  };
};

/**
 * An Instrument kind (ADR 0158) an Add-on provides. Its engine also runs in
 * the audio worklet, from the Add-on's worklet module, which registers it
 * with `registerWorkletEngine` under the same kind.
 */
export type AddOnInstrumentModule = {
  /** The name a new Instrument of the kind is given, such as `synth`. */
  instanceName: string;
  kind(api: AddOnInstrumentApi): InstrumentKind;
  /** Its name in Info. */
  label: string;
};

/** What a Literal Editor's window gives it (ADR 0175). */
export type LiteralEditorHost = {
  /** The window's body, which the editor draws into. */
  element: HTMLElement;
  /**
   * Rewrites the literal's characters `from`–`to` as `insert`, as an edit
   * of the source; why not, when it can't.
   */
  replace(from: number, to: number, insert: string): string | undefined;
  view: AddOnViewApi;
};

/** A Literal Editor's view of its literal, which its window drives. */
export type LiteralEditorView = {
  /** Its window is closing. */
  close?(): void;
  /**
   * A Pattern Event of the literal sounds now for `ms`: its characters and,
   * when known, the pattern's cycle it falls in.
   */
  heard?(event: {
    cycle: number | undefined;
    from: number;
    ms: number;
    to: number;
  }): void;
  /** Shows the literal as it is now. */
  show(state: Extract<LiteralState, { text: string }>): void;
};

/** A Literal Editor (ADR 0175): another view of one kind of source literal. */
export type LiteralEditorModule = {
  /** Its name in menus and its window's title, such as `Piano Roll`. */
  label: string;
  literal: LiteralKind;
  open(host: LiteralEditorHost): LiteralEditorView;
};

/** An Add-on module's default export. */
export type AddOnModule = {
  /** The Add-on's URL (ADR 0162). */
  id: string;
  /** Its Instrument kinds by name, written `<id>#<name>` as Element kinds are. */
  instruments?: Readonly<Record<string, AddOnInstrumentModule>>;
  /** Its Element kinds by name, each written `<id>#<name>` in a Project. */
  kinds: Readonly<Record<string, AddOnKindModule>>;
  /** Its Literal Editors by name; only Add-ons built with Folio have them. */
  literalEditors?: Readonly<Record<string, LiteralEditorModule>>;
  version: string;
};

/** Checks an Add-on module's shape; it is plain data with factories. */
export const defineAddOn = (addOn: AddOnModule): AddOnModule => addOn;
