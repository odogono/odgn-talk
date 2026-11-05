// The browser's Host for the chat: a Group running page.talk, its own
// WebCrypto key, and one WebSocket link to the server (ADR 0165). Web APIs
// only, so the example's page and the CLI's tests share it.
import {
  consoleCapability,
  newGroup,
  peerCapability,
  text,
  type Costs,
} from '@northtalk/ts';
import { newDrivenGroup } from '@northtalk/ts/driver';
import { PeerRouter, webSocketLink } from '@northtalk/ts/peer';

const free = { fuel: 0 };
const peerCosts: Costs = {
  expose: free,
  unexpose: free,
  reach: free,
  post: free,
  call: free,
  caller: free,
};
const consoleCosts: Costs = { write: free, read: free };

export type ChatOptions = {
  nick: string;
  /** page.talk's source. */
  source: string;
  /** The server's address, such as `ws://127.0.0.1:7401`. */
  url: string;
  /** Shows a line the page's Script says. */
  write: (line: string) => void;
};

/** Joins the chat; `type` sends a line, and `close` leaves. */
export const joinChat = async (o: ChatOptions) => {
  const { group, drive } = newDrivenGroup({ newGroup }, { name: o.nick });
  const router = await PeerRouter.create(group);
  const link = webSocketLink(new WebSocket(o.url), { name: 'chat' });
  router.connect(link);
  const script = group.load({
    name: 'page',
    source: o.source,
    grants: {
      peer: peerCapability(router.impl, peerCosts).grant('all', null),
      console: consoleCapability(
        {
          write: (_call, value) => o.write(value.asText() ?? value.toString()),
          read: call => call.answer(text('')),
        },
        consoleCosts,
      ).grant('all', null),
    },
  });
  await script.request({ name: 'start', args: [text(o.nick)] }).result;
  return {
    link,
    type: (line: string) =>
      script.deliver({ name: 'type', args: [text(line)] }),
    close: async () => {
      router.close();
      await drive.close();
    },
  };
};
