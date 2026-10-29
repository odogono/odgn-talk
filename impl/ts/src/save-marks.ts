// The bookkeeping a save reads that TS execution never does: where each
// Capability call was made, the order waits began, and a Run's last wait.
// The records hold these as the Zig Core keeps them (chapter 10, The save
// format); nothing here changes what a Run does.

/** Where a call was made, set as it is made. */
export type CallSite = {
  args: readonly unknown[];
  at: { col: number; line: number; pc: number; unit: string };
  /** The Fuel charged for it, once its Host has taken it. */
  charged: number;
  now: bigint;
  /** Its place in the order calls were made. */
  order: number;
  segment: string;
};
export const callSites = new WeakMap<object, CallSite>();
let calls = 0;
export const nextCallOrder = () => ++calls;

/** The place a Run's or Join Member's wait has in the order waits began. */
export const waitOrders = new WeakMap<object, number>();

/** A Run's last Suspension Point and wait, which a save keeps after it resumes. */
export type LastWait = {
  suspendedAt: string;
  waited?: WaitFields;
  /** The wait it is in now, which becomes `waited` once it settles. */
  waiting?: WaitFields;
};
export type WaitFields = {
  after: bigint;
  block: boolean;
  /** Its call, for a Capability call. */
  call?: object;
  declared: boolean;
  grant: string;
  id: string;
  operation: string;
};
export const lastWaits = new WeakMap<object, LastWait>();

/** The order a Run last came to rest in, which a Script's live Runs follow. */
export const restOrders = new WeakMap<object, number>();
let rests = 0;
/** A Run coming to rest: preempted, suspended or parked. */
export const markRest = (
  running: object,
  spent: { alloc: number; fuel: number },
) => {
  restOrders.set(running, ++rests);
  stretchStarts.set(running, { fuel: spent.fuel, alloc: spent.alloc });
};

/** The Fuel and allocation a Run had when it last came to rest. */
export const stretchStarts = new WeakMap<
  object,
  { alloc: number; fuel: number }
>();

/** A segment base's length before an extension padded it. */
export const baseLengths = new WeakMap<object, number>();
