// Which Project Add-ons this reader trusts, by their code's hash (ADR
// 0162). Kept in this browser only; a changed Add-on has a new hash and
// asks again. Storage that fails, such as in a private window, trusts only
// for this visit.

const KEY = 'folio-trusted-add-ons';

export class TrustStore {
  readonly #hashes = new Set<string>();
  // NorthTalk-signed Add-ons (#1967), trusted for this visit only, so a
  // rotated key stops vouching for them at the next Folio release.
  readonly #signed = new Set<string>();
  readonly #storage: Storage | undefined;

  constructor(storage: Storage | undefined = globalThis.localStorage) {
    this.#storage = storage;
    try {
      const saved = JSON.parse(storage?.getItem(KEY) ?? '[]') as unknown;
      if (Array.isArray(saved)) {
        for (const hash of saved) {
          if (typeof hash === 'string') {
            this.#hashes.add(hash);
          }
        }
      }
    } catch {
      // Unreadable storage trusts nothing yet.
    }
  }

  has(hash: string): boolean {
    return this.#hashes.has(hash) || this.#signed.has(hash);
  }

  /** Trusts Add-ons whose NorthTalk signature verified, without saving. */
  vouch(hashes: readonly string[]): void {
    for (const hash of hashes) {
      this.#signed.add(hash);
    }
  }

  /** Every trusted hash, as the Play worker is told them. */
  all(): string[] {
    return [...this.#hashes];
  }

  trust(hashes: readonly string[]): void {
    for (const hash of hashes) {
      this.#hashes.add(hash);
    }
    try {
      this.#storage?.setItem(KEY, JSON.stringify(this.all()));
    } catch {
      // Trusted for this visit only.
    }
  }
}
