// Chromium: a field in a page with no stylesheet shows coloured tokens in the
// theme's font and underlines the diagnostics.
import { EditorView } from '@codemirror/view';
import { expect, smoke } from './smoke.js';

const frame = () => new Promise(resolve => requestAnimationFrame(resolve));

const check = async () => {
  const view = new EditorView({
    state: smoke(),
    parent: document.querySelector('#field'),
  });
  await frame();
  const put = [...view.dom.querySelectorAll('.cm-line span')].find(
    // The innermost span: a diagnostic wraps the token in its own.
    span => span.textContent === 'put' && !span.firstElementChild,
  );
  expect(put, 'no highlighted span for put');
  const colour = () => getComputedStyle(put).color;
  expect(
    colour() === 'rgb(122, 62, 157)',
    `keyword fallback colour ${colour()}`,
  );
  document.documentElement.style.setProperty('--northtalk-keyword', '#ff0000');
  expect(colour() === 'rgb(255, 0, 0)', `keyword variable colour ${colour()}`);
  const font = getComputedStyle(
    view.dom.querySelector('.cm-scroller'),
  ).fontFamily;
  expect(font.startsWith('ui-monospace'), `scroller font ${font}`);
  expect(
    view.dom.querySelector('.cm-lintRange-error')?.textContent === '2',
    'no error underline',
  );
  return 'highlighted, themed and underlined';
};

check().then(
  result => (document.title = `ok: ${result}`),
  error => (document.title = `error: ${error.stack}`),
);
