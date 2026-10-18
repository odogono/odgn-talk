import { expect, test } from 'bun:test';
import {
  WorkerSupervisor,
  type Envelope,
  type Reply,
  type SupervisedWorker,
} from '../src/worker-supervisor';

type Request = { t: string };
type Response = { t: string };

// A fake worker that records what it is sent and replies only when told to.
class FakeWorker implements SupervisedWorker {
  onmessage: ((event: MessageEvent) => void) | null = null;
  readonly received: Envelope<Request>[] = [];
  terminated = false;
  postMessage(message: unknown): void {
    this.received.push(message as Envelope<Request>);
  }
  terminate(): void {
    this.terminated = true;
  }
  // Sends a message as the worker would, whether or not the page still listens.
  send(reply: Reply<Response>): void {
    this.onmessage?.(new MessageEvent('message', { data: reply }));
  }
  // Replies to the latest request it received.
  answer(response: Response): void {
    this.send({ id: this.received.at(-1)!.id, response });
  }
}

const ENDED: Response = { t: 'ended' };

const supervised = () => {
  const workers: FakeWorker[] = [];
  const messages: [Response, number | undefined][] = [];
  let terminations = 0;
  const supervisor = new WorkerSupervisor<Request, Response>({
    spawn: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    ended: ENDED,
    onMessage: (response, id) => messages.push([response, id]),
    onTerminated: () => terminations++,
  });
  return { supervisor, workers, messages, terminations: () => terminations };
};

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

test('a call resolves with the reply that carries its id', async () => {
  const { supervisor, workers, messages } = supervised();
  const first = supervisor.call({ t: 'a' });
  const second = supervisor.call({ t: 'b' });
  const worker = workers[0]!;
  expect(worker.received).toEqual([
    { id: 1, request: { t: 'a' } },
    { id: 2, request: { t: 'b' } },
  ]);
  worker.send({ id: 2, response: { t: 'B' } });
  worker.send({ id: 1, response: { t: 'A' } });
  expect(await first).toEqual({ t: 'A' });
  expect(await second).toEqual({ t: 'B' });
  expect(messages.map(([, id]) => id)).toEqual([2, 1]);
});

test('a message with no id goes to onMessage only', () => {
  const { workers, messages } = supervised();
  workers[0]!.send({ response: { t: 'state' } });
  expect(messages).toEqual([[{ t: 'state' }, undefined]]);
});

test('a supervised request answered in time keeps the worker', async () => {
  const { supervisor, workers, terminations } = supervised();
  const reply = supervisor.supervise({ t: 'cancel' }, { deadlineMs: 20 });
  workers[0]!.answer({ t: 'cancelled' });
  expect(await reply).toEqual({ t: 'cancelled' });
  await tick(40);
  expect(workers).toHaveLength(1);
  expect(workers[0]!.terminated).toBe(false);
  expect(terminations()).toBe(0);
});

test('a supervised request with no reply ends the worker and every pending request', async () => {
  const { supervisor, workers, messages, terminations } = supervised();
  const busy = supervisor.call({ t: 'line' });
  const cancel = supervisor.supervise({ t: 'cancel' }, { deadlineMs: 20 });
  expect(await busy).toBe(ENDED);
  expect(await cancel).toBe(ENDED);
  expect(workers).toHaveLength(2);
  expect(workers[0]!.terminated).toBe(true);
  expect(workers[1]!.terminated).toBe(false);
  expect(terminations()).toBe(1);
  // The ended worker's late messages are dropped.
  workers[0]!.send({ id: 1, response: { t: 'late' } });
  workers[0]!.send({ response: { t: 'late' } });
  expect(messages).toEqual([]);
  // The new worker carries on, with ids that don't repeat.
  const next = supervisor.call({ t: 'open' });
  workers[1]!.answer({ t: 'opened' });
  expect(await next).toEqual({ t: 'opened' });
  expect(workers[1]!.received).toEqual([{ id: 3, request: { t: 'open' } }]);
});

test('the default deadline is 500 ms', async () => {
  const { supervisor, workers } = supervised();
  void supervisor.supervise({ t: 'cancel' });
  await tick(400);
  expect(workers).toHaveLength(1);
  await tick(150);
  expect(workers).toHaveLength(2);
});
