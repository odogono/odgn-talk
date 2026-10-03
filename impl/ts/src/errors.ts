import { nothing, type Value } from './values';

// The catalogue is deliberately open to the later embedding implementation.
export type HostErrorCode =
  | 'clock backwards'
  | 'parent cycle'
  | 'duplicate object id'
  | 'name reused'
  | 'reentrant call'
  | 'wrong group'
  | 'library mismatch'
  | 'reserved name'
  | 'not adoptable'
  | 'invalid value'
  | 'invalid save'
  | 'save mismatch'
  | 'unknown call'
  | 'state too large'
  | 'effects pending'
  | 'effect state unknown';

export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string = code,
  ) {
    super(message);
    this.name = 'HostError';
  }
}

export const invalidValue: (message: string) => never = message => {
  throw new HostError('invalid value', message);
};

/** A load-time diagnostic, or the first syntax error, as a LoadError carries it. */
export type LoadDiagnostic = {
  code: string;
  col: number;
  line: number;
  message: string;
  unit: string;
};
/** A rejected Load (chapter 9): its diagnostics, in order. */
export class LoadError extends Error {
  constructor(readonly diagnostics: readonly LoadDiagnostic[]) {
    super(diagnostics.map(d => `${d.code} at ${d.line}:${d.col}`).join(', '));
    this.name = 'LoadError';
  }
}

/** Load shedding at a Delivery's call, not a bug (chapter 9, Deliveries). */
export class MailboxFull extends Error {
  override name = 'MailboxFull';
}

/**
 * A Script-level error as the Host sees it, such as a Request's `send failed`
 * or a `run end`'s error. Its `data` is a map, or Nothing.
 */
export class ScriptError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly data: Value = nothing,
  ) {
    super(message);
    this.name = 'ScriptError';
  }
}
