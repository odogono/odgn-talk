/// <reference lib="esnext.disposable" preserve="true" />
// Lifetime Helpers use only the shared embedding interface (ADRs 0121, 0130).
import {
  asyncDispose,
  newDrivenGroup,
  type Drive,
  type DrivenGroupOptions,
} from './driver';
import type { Core, Group } from './embedding';

/** A Group whose driver closes explicitly or at the end of an `await using` scope. */
export type DrivenGroup = Group &
  Pick<Drive, 'close' | typeof Symbol.asyncDispose>;

/** The Zig Host Adapter requires its asynchronously created Core. */
export type CreateGroupOptions = DrivenGroupOptions & { core: Core };

/** Creates a driven Group on the supplied Core; close has the driver's shutdown semantics. */
export const createGroup = (o: CreateGroupOptions): DrivenGroup => {
  const { core, ...options } = o;
  const { group, drive } = newDrivenGroup(core, options);
  return Object.assign(group, {
    close: drive.close,
    [asyncDispose]: drive[asyncDispose],
  });
};
