// Chapter 9's process-wide Core. The free functions and this facade share
// compilation caches and Object Kind definitions; Groups own all live state.
import { defineCapability } from './capabilities';
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
import { storeCapability } from './store-capability';

export type Core = {
  calendarCapability: typeof calendarCapability;
  clockCapability: typeof clockCapability;
  compileLibrary: typeof compileLibrary;
  consoleCapability: typeof consoleCapability;
  defineCapability: typeof defineCapability;
  defineObjectKind: typeof defineObjectKind;
  localeCapability: typeof localeCapability;
  newGroup: typeof newGroup;
  restore: typeof restore;
  storeCapability: typeof storeCapability;
  timerCapability: typeof timerCapability;
};

const core: Core = Object.freeze({
  defineCapability,
  defineObjectKind,
  clockCapability,
  calendarCapability,
  localeCapability,
  timerCapability,
  consoleCapability,
  storeCapability,
  compileLibrary,
  newGroup,
  restore,
});

/** Return the process-wide Core, also used by the free-function helpers. */
export const createCore = (): Core => core;
