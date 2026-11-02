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

/** An Add-on module's default export. */
export type AddOnModule = {
  /** The Add-on's URL (ADR 0162). */
  id: string;
  /** Its kinds by name, each written `<id>#<name>` in a Project. */
  kinds: Readonly<Record<string, AddOnKindModule>>;
  version: string;
};

/** Checks an Add-on module's shape; it is plain data with factories. */
export const defineAddOn = (addOn: AddOnModule): AddOnModule => addOn;
