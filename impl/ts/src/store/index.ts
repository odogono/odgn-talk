// Store implementations for the `store` Standard Capability (chapter 7).
// None of this is the Core: a Host passes one to `storeCapability`.
export {
  decodeContents,
  encodeContents,
  sessionQuotas,
  StoreContentsError,
  Stores,
  StoreStateUnknownError,
  type StoreBackend,
  type StoreQuotas,
} from './engine';
export { memoryBackend, memoryStores } from './memory';
export {
  webStorageBackend,
  webStorageStores,
  type WebStorage,
} from './web-storage';
