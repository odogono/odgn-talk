// What a Project offers its author (#2025): the built-in kinds, then the
// kinds of the Add-ons it lists, never every Add-on Folio ships with, and
// never by its Base Project, which is for attribution only (ADR 0161).
import { addOnKinds } from '../elements/registry';
import { splitAddOnKind } from '../elements/add-on';
import { INSTRUMENT_KINDS, instrumentKindNames } from '../instruments/registry';
import type { AddOnRef, Project } from '../model';
import type { DeepReadonly } from '../readonly';
import type { CatalogueEntry } from './catalogue';

type Listed = DeepReadonly<AddOnRef[]> | undefined;

/** A kind the Tools window or the Instruments window offers. */
export type OfferedKind = { icon?: string; kind: string; label: string };

/** The built-in Add-ons a Project lists, in catalogue order. */
const listedBuiltIns = (
  addOns: Listed,
  catalogue: readonly CatalogueEntry[],
): CatalogueEntry[] =>
  catalogue.filter(entry =>
    addOns?.some(ref => ref.id === entry.id && ref.code === undefined),
  );

const listedProjectAddOns = (addOns: Listed): Set<string> =>
  new Set(
    (addOns ?? []).filter(ref => ref.code !== undefined).map(ref => ref.id),
  );

/**
 * The Element kinds a Project's Add-ons add to the Tools window: each
 * listed built-in Add-on's, as the catalogue names them before it loads,
 * then each listed Project Add-on's once it has loaded.
 */
export const offeredElementKinds = (
  addOns: Listed,
  catalogue: readonly CatalogueEntry[],
): OfferedKind[] => {
  const own = listedProjectAddOns(addOns);
  return [
    ...listedBuiltIns(addOns, catalogue).flatMap(entry =>
      entry.kinds.map(k => ({
        kind: `${entry.id}#${k.name}`,
        label: k.label,
        icon: k.icon,
      })),
    ),
    ...addOnKinds()
      .filter(entry => own.has(splitAddOnKind(entry.kind)!.addOn))
      .map(entry => ({
        kind: entry.kind,
        label: entry.definition.label,
        icon: entry.definition.icon,
      })),
  ];
};

/**
 * The Instrument kinds the Instruments window offers: Folio's own, such as the sampler, then
 * each listed built-in Add-on's, never a loaded Add-on the Project doesn't
 * list.
 */
export const offeredInstrumentKinds = (
  addOns: Listed,
  catalogue: readonly CatalogueEntry[],
): OfferedKind[] => {
  const builtIn = [...INSTRUMENT_KINDS.keys()]
    .filter(kind => splitAddOnKind(kind) === undefined)
    .map(kind => ({ kind, label: instrumentKindNames(kind).label }));
  return [
    ...builtIn,
    ...listedBuiltIns(addOns, catalogue).flatMap(entry =>
      (entry.instruments ?? []).map(i => ({
        kind: `${entry.id}#${i.name}`,
        label: i.label,
      })),
    ),
  ];
};

/** What uses an Add-on: its Elements' and Instruments' names. */
export const addOnUsers = (
  project: DeepReadonly<Project>,
  id: string,
): string[] => {
  const uses = (kind: string) => splitAddOnKind(kind)?.addOn === id;
  return [
    ...project.pages.flatMap(page =>
      page.elements.filter(e => uses(e.kind)).map(e => e.name),
    ),
    ...project.instruments.filter(i => uses(i.kind)).map(i => i.name),
  ];
};

/** Why an Add-on can't be removed from a Project, else undefined. */
export const addOnRemovalProblem = (
  project: DeepReadonly<Project>,
  id: string,
): string | undefined => {
  const users = addOnUsers(project, id);
  if (!users.length) {
    return undefined;
  }
  const names = users.map(name => `“${name}”`);
  const list =
    names.length === 1
      ? names[0]
      : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  return `${list} ${users.length === 1 ? 'uses' : 'use'} it`;
};
