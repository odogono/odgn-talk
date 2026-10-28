// Run in a real browser (commands in README.md); a real service worker,
// Cache Storage and manifest, no emulators. The unit tests cover the
// worker's and registration's logic against fakes; these prove the
// installed shell is really there offline-ready. Where the browser has
// no service worker support, the checks say so instead of failing.
import { fileAccessSupport } from '../src/file-access';

const SHELL = [
  '',
  'style.css',
  'main.js',
  'lsp.worker.js',
  'folio.webmanifest',
  'icon-192.png',
];

const assert: (condition: unknown, message: string) => asserts condition = (
  condition,
  message,
) => {
  if (!condition) {
    throw new Error(message);
  }
};

export const runBrowserTests = async () => {
  const results: { error?: string; name: string; passed: boolean }[] = [];
  const test = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
      results.push({ name, passed: true });
    } catch (error) {
      results.push({ name, passed: false, error: String(error) });
    }
  };

  await test('the manifest installs Folio and opens .folio files', async () => {
    const link = document.querySelector<HTMLLinkElement>(
      'link[rel="manifest"]',
    );
    assert(link !== null, 'the page has no manifest link');
    const manifest = (await (await fetch(link.href)).json()) as {
      display: string;
      file_handlers?: { accept: Record<string, string[]> }[];
      icons: { sizes: string; src: string }[];
      name: string;
      short_name: string;
    };
    assert(
      manifest.name === 'Folio, made with NorthTalk',
      `manifest name is ${manifest.name}`,
    );
    assert(manifest.short_name === 'Folio', 'short_name is not Folio');
    assert(manifest.display === 'standalone', 'display is not standalone');
    for (const size of ['192x192', '512x512']) {
      const icon = manifest.icons.find(entry => entry.sizes === size);
      assert(icon !== undefined, `no ${size} icon`);
      const response = await fetch(new URL(icon.src, link.href));
      assert(response.ok, `${icon.src} does not load`);
    }
    assert(
      JSON.stringify(manifest.file_handlers?.[0]?.accept) ===
        JSON.stringify({
          'application/vnd.odgn.northtalk-project+zip': ['.folio'],
        }),
      'file_handlers do not accept .folio',
    );
  });

  await test('the service worker keeps the whole app shell', async () => {
    assert('serviceWorker' in navigator, 'this browser has no service workers');
    // `ready` never settles when the install fails, so bound it.
    const ready = await Promise.race([
      navigator.serviceWorker.ready.then(() => true),
      new Promise<false>(resolve => setTimeout(() => resolve(false), 10_000)),
    ]);
    assert(ready, 'no service worker became active within 10 s');
    // Registration happens at page setup; give a just-registered worker
    // a moment to finish installing its shell.
    let shell: string[] = [];
    for (let attempt = 0; attempt < 50; attempt++) {
      shell = [];
      for (const name of SHELL) {
        if (await caches.match(new URL(`./${name}`, document.baseURI))) {
          shell.push(name);
        }
      }
      if (shell.length === SHELL.length) {
        break;
      }
      await new Promise(resolve => setTimeout(resolve, 200));
    }
    assert(
      shell.length === SHELL.length,
      `only these shell files are cached: ${shell.join(', ')}`,
    );
    const page = await caches.match(new URL('./', document.baseURI));
    const text = await page!.text();
    assert(text.includes('<title>Folio</title>'), 'cached page is not Folio');
  });

  await test('disk saving support is reported honestly', async () => {
    const support = fileAccessSupport(window);
    assert(
      typeof support.save === 'boolean' && typeof support.open === 'boolean',
      'support is not reported',
    );
    // Unsupported browsers keep the plain Import picker and Export's
    // download; supported ones also show Save. Either way the Projects
    // window says which, once the app has mounted.
    const status = document.getElementById('file-access-status');
    if (status) {
      assert(
        status.textContent!.length > 0,
        'the file-access message is empty',
      );
    }
  });

  return results;
};
