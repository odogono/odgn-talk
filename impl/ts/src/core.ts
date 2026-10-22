// Chapter 9's process-wide Core. The free functions and this Core object share
// compilation caches and Object Kind definitions; Groups own all live state.
import { defineCapability } from './capabilities';
import type { Core } from './embedding';
import { newGroup, restore } from './group';
import { compileLibrary } from './library';
import { localeCapability } from './locale-capability';
import { defineObjectKind } from './objects';
import {
  calendarCapability,
  clockCapability,
  consoleCapability,
  timerCapability,
} from './standard-capabilities';
import { sqliteCapability } from './sqlite-capability';
import { storeCapability } from './store-capability';
import { userCapability } from './user-capability';
import { httpCapability } from './http-capability';
import { coreVersions } from './versions';

/** The TS Core: the embedding interface's Core, with its Groups typed as TsGroup. */
// Core's members, with the TS Core's own Group and its extra overloads.
export type TsCore = Omit<
  Core,
  'compileLibrary' | 'defineObjectKind' | 'newGroup' | 'restore'
> & {
  compileLibrary: typeof compileLibrary;
  defineObjectKind: typeof defineObjectKind;
  newGroup: typeof newGroup;
  restore: typeof restore;
};

const core: TsCore = Object.freeze({
  defineCapability,
  defineObjectKind,
  clockCapability,
  calendarCapability,
  localeCapability,
  timerCapability,
  consoleCapability,
  storeCapability,
  sqliteCapability,
  userCapability,
  httpCapability,
  compileLibrary,
  newGroup,
  restore,
  versions: coreVersions,
});

// Removing a member from either fails here, as in WasmCore.
core satisfies Core;

/** Return the process-wide Core, also used by the free-function helpers. */
export const createCore = (): TsCore => core;
