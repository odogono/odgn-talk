// The worker supervisor: a page's side of a browser Host that runs in a
// worker (#1216). It matches each reply to its request by id, and ends a
// worker that doesn't answer a supervised request in time, so a Script that
// never yields can't hold the Host. A worker reads no message while it runs,
// so its reply is the acknowledgement: it answers once it is free. The app
// keeps its own Host and protocol inside the worker, and decides what a
// supervised request asks for and what follows a termination.

/** What the supervisor needs of a `Worker`. */
export type SupervisedWorker = {
  onmessage: ((event: MessageEvent) => void) | null;
  postMessage(message: unknown): void;
  terminate(): void;
};

/** A request as the worker receives it. */
export type Envelope<Request> = { id: number; request: Request };
/** A message from the worker: a reply to request `id`, or one it sent unasked. */
export type Reply<Response> = { id?: number; response: Response };

export type WorkerSupervisorOptions<Response> = {
  /**
   * What each pending request resolves with when its worker is ended, such
   * as an error response.
   */
  ended: Response;
  /**
   * Receives every message from the current worker, in order, before the
   * request it answers resolves.
   */
  onMessage(response: Response, id: number | undefined): void;
  /** Called once a worker has been ended and its replacement spawned. */
  onTerminated(): void;
  /** Starts a worker. */
  spawn(): SupervisedWorker;
};

/** The default wait for a supervised request's reply, in milliseconds (ADR 0086). */
export const SUPERVISE_DEADLINE_MS = 500;

export class WorkerSupervisor<Request, Response> {
  private worker: SupervisedWorker;
  private nextId = 1;
  private readonly pending = new Map<number, (response: Response) => void>();

  constructor(private readonly options: WorkerSupervisorOptions<Response>) {
    this.worker = this.start();
  }

  /** Posts a request, and resolves with the worker's reply to it. */
  call(request: Request): Promise<Response> {
    const id = this.nextId++;
    this.worker.postMessage({ id, request } satisfies Envelope<Request>);
    return new Promise(resolve => this.pending.set(id, resolve));
  }

  /**
   * Posts a request, and ends the worker when it hasn't replied within the
   * deadline. Every pending request then resolves with `ended`, the worker's
   * late messages are dropped, and a new worker takes its place.
   */
  supervise(
    request: Request,
    { deadlineMs = SUPERVISE_DEADLINE_MS }: { deadlineMs?: number } = {},
  ): Promise<Response> {
    const worker = this.worker;
    const reply = this.call(request);
    const timer = setTimeout(() => {
      if (this.worker === worker) {
        this.terminate();
      }
    }, deadlineMs);
    return reply.finally(() => clearTimeout(timer));
  }

  private start(): SupervisedWorker {
    const worker = this.options.spawn();
    worker.onmessage = ({ data }) => {
      if (this.worker !== worker) {
        return;
      }
      const { id, response } = data as Reply<Response>;
      this.options.onMessage(response, id);
      if (id !== undefined) {
        const resolve = this.pending.get(id);
        this.pending.delete(id);
        resolve?.(response);
      }
    };
    return worker;
  }

  private terminate(): void {
    this.worker.onmessage = null;
    this.worker.terminate();
    const pending = [...this.pending.values()];
    this.pending.clear();
    for (const resolve of pending) {
      resolve(this.options.ended);
    }
    this.worker = this.start();
    this.options.onTerminated();
  }
}
