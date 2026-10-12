// The in-memory Store backend: each Store starts empty and lives as long as
// the process (chapter 12, The Session Store).
import type { RouterOptions } from '../notify/router';
import {
  sessionWatchLimits,
  Stores,
  type StoreBackend,
  type StoreQuotas,
} from './engine';

/** A backend that keeps nothing outside the engine's own copy. */
export const memoryBackend = (): StoreBackend => ({
  load: () => [],
  save: () => {},
});

/**
 * Stores kept only in memory, each starting empty. `admitted` is told after
 * each Notification a Group admits.
 */
export const memoryStores = (
  quotas: StoreQuotas,
  admitted?: RouterOptions['admitted'],
): Stores => new Stores(memoryBackend(), quotas, sessionWatchLimits, admitted);
