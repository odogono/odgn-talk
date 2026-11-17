// The Play worker (#1225): Browse and Present run their Play Session here,
// so a Script that never yields holds only this worker, which the page's
// supervisor ends. `PlayHost` holds a session's requests while its Add-ons
// load (#1901).
import { type Envelope } from '@northtalk/tooling/worker-supervisor';
import { AddOnLoader } from './add-ons/loader';
import { PlayHost } from './play-host';
import { type PlayRequest } from './play-protocol';

const host = new PlayHost(reply => postMessage(reply), {
  // The page asks the reader; the worker runs what the page says they trust.
  addOns: trusted => new AddOnLoader({ trusted }),
});

onmessage = ({ data }: MessageEvent<Envelope<PlayRequest>>) => {
  host.receive(data);
};
