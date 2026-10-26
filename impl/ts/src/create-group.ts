import { createCore } from './core';
import type { DrivenGroupOptions } from './driver';
import type { Core } from './embedding';
import {
  createGroup as createDrivenGroup,
  type DrivenGroup,
} from './group-helper';

export type { DrivenGroup } from './group-helper';

/** Omitting core uses the process-wide TS Core. */
export type CreateGroupOptions = DrivenGroupOptions & { core?: Core };

/** Creates a driven Group that supports `await using` and explicit close(reason). */
export const createGroup = (o: CreateGroupOptions): DrivenGroup =>
  createDrivenGroup({ ...o, core: o.core ?? createCore() });
