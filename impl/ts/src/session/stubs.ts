// Chapter 11, Stubs: what a runner's Host function returns at the next call
// of an Operation, queued in advance. The Trace Case runner and the Session
// Host's mocks share them, so both answer calls the same way.
import { ScriptError } from '../errors';
import { recordLine, traceValue } from '../trace';
import { map, nothing, type Value } from '../values';

export type Stub = { charge: number; error?: Value; value?: Value };

/** An error map as a Host function fails with it, its code and message apart. */
export const hostFailure = (error: Value): ScriptError =>
  new ScriptError(
    error.get('code').asText() ?? '',
    error.get('message').asText() ?? '',
    map(error.entries().filter(([k]) => k !== 'code' && k !== 'message')),
  );

/** The `stub` line a runner writes into the Trace for a Stub it queues. */
export const stubLine = (operation: string, stub: Stub): string =>
  recordLine(
    'stub',
    [operation],
    [
      ['value', stub.value ? traceValue(stub.value) : null],
      ['error', stub.error ? traceValue(stub.error) : null],
      ['charge', stub.charge ? String(stub.charge) : null],
    ],
    true,
  );

/** The Stubs queued for each Operation, named `<capability>.<operation>`. */
export class Stubs {
  private readonly queues = new Map<string, Stub[]>();

  add(operation: string, stub: Stub): void {
    this.queues.set(operation, [...(this.queues.get(operation) ?? []), stub]);
  }

  /**
   * An immediate or fire-and-forget call: the next Stub's value, or its
   * failure, after its charge. With none, a `needed` call fails, and the
   * Script sees `host error`.
   */
  take(
    operation: string,
    call: { charge(fuel: number): void },
    needed: boolean,
  ): Value {
    const stub = this.queues.get(operation)?.shift();
    if (!stub) {
      if (needed) {
        throw new Error(`No Stub for ${operation}`);
      }
      return nothing;
    }
    if (stub.charge) {
      call.charge(stub.charge);
    }
    if (stub.error) {
      if (!stub.error.entries().length) {
        throw new Error(`The Stub for ${operation} fails`);
      }
      throw hostFailure(stub.error);
    }
    return stub.value ?? nothing;
  }

  /** A suspending call takes a Stub for its charge only. */
  start(operation: string, call: { charge(fuel: number): void }): void {
    const stub = this.queues.get(operation)?.shift();
    if (stub?.charge) {
      call.charge(stub.charge);
    }
  }
}
