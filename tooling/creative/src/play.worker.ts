// The Play worker (#1225): Browse and Present run their Play Session here,
// so a Script that never yields holds only this worker, which the page's
// supervisor ends. A session's Add-ons load before it opens (#1901); the
// requests that arrive meanwhile wait, in order.
import { type Envelope } from '@northtalk/tooling/worker-supervisor';
import { AddOnLoader } from './add-ons/loader';
import { PlayHost } from './play-host';
import { type PlayRequest } from './play-protocol';

const host = new PlayHost(reply => postMessage(reply));
const addOns = new AddOnLoader();
let waiting: Envelope<PlayRequest>[] | undefined;

const receive = (data: Envelope<PlayRequest>): void => {
  const { request } = data;
  if (request.kind !== 'open' || !request.project.addOns?.length) {
    host.receive(data);
    return;
  }
  waiting = [];
  void addOns.load(request.project.addOns).then(() => {
    host.receive(data);
    const queued = waiting!;
    waiting = undefined;
    // Another open among them waits again, holding the rest behind it.
    for (const [i, next] of queued.entries()) {
      const held = waiting as Envelope<PlayRequest>[] | undefined;
      if (held) {
        held.push(...queued.slice(i));
        break;
      }
      receive(next);
    }
  });
};

onmessage = ({ data }: MessageEvent<Envelope<PlayRequest>>) => {
  if (waiting) {
    waiting.push(data);
  } else {
    receive(data);
  }
};
