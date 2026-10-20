import { type PerformanceSnapshot } from './performance';

/** Session and capture epochs reject late snapshots, including after Clear. */
export class PerformanceResults {
  session = 0;
  epoch = 0;
  incomplete = false;
  snapshot: PerformanceSnapshot | undefined;
  reset(session: number): void {
    this.session = session;
    this.epoch++;
    this.snapshot = undefined;
    this.incomplete = false;
  }
  clear(): void {
    this.epoch++;
    this.snapshot = undefined;
    this.incomplete = false;
  }
  receive(session: number, snapshot: PerformanceSnapshot): boolean {
    if (
      session !== this.session ||
      snapshot.epoch !== this.epoch ||
      this.incomplete
    ) {
      return false;
    }
    this.snapshot = snapshot;
    return true;
  }
  interrupted(): void {
    this.incomplete = true;
    if (this.snapshot) {
      this.snapshot = { ...this.snapshot, status: 'incomplete' };
    }
  }
}
