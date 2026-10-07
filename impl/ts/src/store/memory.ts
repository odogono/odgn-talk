// The in-memory Store backend: each Store starts empty and lives as long as
// the process (chapter 12, The Session Store).
import { Stores, type StoreBackend, type StoreQuotas } from './engine';

/** A backend that keeps nothing outside the engine's own copy. */
export const memoryBackend = (): StoreBackend => ({
  load: () => [],
  save: () => {},
});

/** Stores kept only in memory, each starting empty. */
export const memoryStores = (quotas: StoreQuotas): Stores =>
  new Stores(memoryBackend(), quotas);
