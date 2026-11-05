// The chat page: a Host in the browser that joins the server's chat over a
// WebSocket. `?ws=` gives another server, `?nick=` the name to join as.
import { joinChat } from './browser-host';
import source from './page.talk' with { type: 'text' };

const params = new URLSearchParams(location.search);
const log = document.querySelector<HTMLOListElement>('#log')!;
const form = document.querySelector<HTMLFormElement>('form')!;
const input = form.querySelector<HTMLInputElement>('input')!;

const chat = await joinChat({
  nick: params.get('nick') ?? `guest${Math.floor(Math.random() * 1000)}`,
  source,
  url: params.get('ws') ?? 'ws://127.0.0.1:7401',
  write: line => {
    const item = document.createElement('li');
    item.textContent = line;
    log.append(item);
  },
});
form.addEventListener('submit', event => {
  event.preventDefault();
  if (input.value) {
    chat.type(input.value);
    input.value = '';
  }
});
