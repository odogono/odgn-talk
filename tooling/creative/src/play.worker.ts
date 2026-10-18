// The Play worker (#1225): Browse and Present run their Play Session here,
// so a Script that never yields holds only this worker, which the page's
// supervisor ends.
import { type Envelope } from '@northtalk/tooling/worker-supervisor';
import { PlayHost } from './play-host';
import { type PlayRequest } from './play-protocol';

const host = new PlayHost(reply => postMessage(reply));
onmessage = ({ data }: MessageEvent<Envelope<PlayRequest>>) =>
  host.receive(data);
