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
  | 'state too large';

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
