import { thaw } from '../src/readonly';
// Run on the dedicated test page described in README.md. Exercises real image
// decoders, IndexedDB and the editor's picker/drop/export/import wiring.
import { EditLock } from '../src/edit-lock';
import { importImage } from '../src/images';
import { createProject, type Project } from '../src/model';
import {
  readProjectFile,
  serializeProject,
  writeProjectFile,
} from '../src/project-file';
import { mountProjects } from '../src/projects';
import { mountStack } from '../src/stack';
import { openProjectStorage } from '../src/storage';
import { writeZip } from '../src/zip';

const assert = (value: unknown, message: string) => {
  if (!value) {
    throw new Error(message);
  }
};
const until = async (check: () => boolean | Promise<boolean>) => {
  for (let i = 0; i < 100; i++) {
    if (await check()) {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('Timed out waiting for the editor');
};
const node = (id: string) => document.getElementById(id)!;
const drop = (target: HTMLElement, file: File) => {
  const transfer = new DataTransfer();
  transfer.items.add(file);
  target.dispatchEvent(
    new DragEvent('drop', {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer,
      clientX: 300,
      clientY: 200,
    }),
  );
};
const svg = (color: string) =>
  new File(
    [
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="30"><rect width="40" height="30" fill="${color}"/><script>globalThis.svgExecuted = true</script></svg>`,
    ],
    `${color}.svg`,
  );

const pick = (button: HTMLElement, file: File) => {
  const nativePicker = HTMLInputElement.prototype.click;
  HTMLInputElement.prototype.click = function () {
    const transfer = new DataTransfer();
    transfer.items.add(file);
    this.files = transfer.files;
    this.dispatchEvent(new Event('change'));
  };
  try {
    button.click();
  } finally {
    HTMLInputElement.prototype.click = nativePicker;
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
  const storage = await openProjectStorage(indexedDB);
  const project = createProject(`Image browser check ${Date.now()}`);
  const record = await storage.saveProject(undefined, project);
  const delegate = {
    flush: async () => {},
    onEditing: (_editing: boolean) => {},
  };
  const lock = new EditLock(undefined, undefined, {
    flush: () => delegate.flush(),
    onEditing: editing => delegate.onEditing(editing),
  });
  await lock.acquire(record.id);
  const shell = mountStack(project);
  mountProjects({
    shell,
    storage,
    initial: { id: record.id, migrated: false, project, record },
    lock,
    lockDelegate: delegate,
    channel: undefined,
  });
  let exported: Uint8Array | undefined;
  let exportedName = '';
  const blobs = new Map<string, Blob>();
  const nativeUrl = URL.createObjectURL;
  URL.createObjectURL = object => {
    const url = nativeUrl(object);
    if ('arrayBuffer' in object) {
      blobs.set(url, object);
    }
    return url;
  };
  const nativeClick = HTMLAnchorElement.prototype.click;
  HTMLAnchorElement.prototype.click = function () {
    exportedName = this.download;
    void blobs
      .get(this.href)!
      .arrayBuffer()
      .then(bytes => {
        exported = new Uint8Array(bytes);
      });
  };
  try {
    await test('real decoders reject damaged images and accept PNG, JPEG, WebP, GIF and SVG', async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 2;
      canvas.height = 2;
      for (const type of ['image/png', 'image/jpeg', 'image/webp']) {
        const blob = await new Promise<Blob>(resolve =>
          canvas.toBlob(blob => resolve(blob!), type),
        );
        const image = await importImage(new File([blob], 'wrong.extension'));
        assert(image.asset.mediaType === type, `wrong media type for ${type}`);
      }
      const gif = Uint8Array.from(
        atob('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'),
        c => c.charCodeAt(0),
      );
      await importImage(new File([gif], 'tiny.gif'));
      await importImage(svg('red'));
      let refused = false;
      try {
        await importImage(
          new File(
            [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
            'broken.png',
          ),
        );
      } catch {
        refused = true;
      }
      assert(refused, 'damaged PNG accepted');
    });
    await test('image picker and Page drop deduplicate and render SVG through img', async () => {
      pick(
        document.querySelector<HTMLElement>('[data-kind="image"]')!,
        svg('red'),
      );
      await until(() => shell.editor.project.pages[0]!.elements.length === 1);
      drop(node('page'), svg('red'));
      await until(() => shell.editor.project.pages[0]!.elements.length === 2);
      assert(
        shell.editor.project.assets.length === 1 &&
          shell.images.bytes.size === 1,
        'image not deduplicated',
      );
      assert(
        node('page').querySelectorAll('img').length === 2,
        'missing image rendering',
      );
      assert(!node('page').querySelector('svg, script'), 'SVG markup inserted');
      assert(!('svgExecuted' in globalThis), 'SVG script executed');
      await delegate.flush();
      const bytes = await storage.assetBytes(
        shell.editor.project.assets.map(a => a.hash),
      );
      assert(bytes.size === 1, 'asset not saved');
    });
    await test('autosave captures one revision and follows edits made during a pending write', async () => {
      const save = storage.saveProject.bind(storage);
      const originalName = shell.editor.project.name;
      let release!: () => void;
      let entered!: () => void;
      const gate = new Promise<void>(resolve => {
        release = resolve;
      });
      const started = new Promise<void>(resolve => {
        entered = resolve;
      });
      let first: Parameters<typeof save>[1] | undefined;
      let writes = 0;
      storage.saveProject = async (id, model, options) => {
        writes++;
        if (writes === 1) {
          first = model;
          entered();
          await gate;
        }
        return save(id, model, options);
      };
      try {
        shell.editor.edit(({ tree }) =>
          tree.setProjectName('Captured revision'),
        );
        const flushing = delegate.flush();
        await started;
        shell.editor.edit(({ tree }) => tree.setProjectName('Newer revision'));
        assert(
          first?.name === 'Captured revision',
          'Pending write retained a live Project',
        );
        release();
        await flushing;
        const loaded = await storage.loadProject(record.id);
        assert(
          loaded.project.name === 'Newer revision' && writes >= 2,
          'Newer edit was marked saved by the earlier write',
        );
      } finally {
        release();
        storage.saveProject = save;
        shell.editor.edit(({ tree }) => tree.setProjectName(originalName));
        await delegate.flush();
      }
    });
    await test('wrong types and undecodable drops preserve the Project and report the reason', async () => {
      const before = JSON.stringify(shell.editor.project);
      drop(node('page'), new File(['plain text'], 'fake.png'));
      await until(() =>
        node('notice-text').textContent!.includes('unsupported image type'),
      );
      assert(
        JSON.stringify(shell.editor.project) === before,
        'wrong type changed Project',
      );
      drop(
        node('page'),
        new File(
          [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])],
          'broken.png',
        ),
      );
      await until(() =>
        node('notice-text').textContent!.includes('could not be decoded'),
      );
      assert(
        JSON.stringify(shell.editor.project) === before,
        'undecodable image changed Project',
      );
    });
    await test('replacement is undoable and unused bytes are omitted from export', async () => {
      for (const element of shell.editor.project.pages[0]!.elements) {
        shell.editor.click(element.name);
        shell.redraw();
        await until(
          () =>
            !!node('info').querySelector(
              `[data-replace-image="${element.name}"]`,
            ),
        );
        pick(
          node('info').querySelector<HTMLElement>('[data-replace-image]')!,
          svg('blue'),
        );
        await until(
          () =>
            shell.editor.element(element.name)?.kind === 'image' &&
            JSON.stringify(shell.editor.element(element.name)).includes(
              'blue.svg',
            ),
        );
      }
      shell.editor.undo();
      shell.redraw();
      assert(
        JSON.stringify(shell.editor.project.pages[0]!.elements).includes(
          'red.svg',
        ),
        'undo lost original',
      );
      shell.editor.redo();
      shell.redraw();
      document.querySelector<HTMLElement>('[data-export-now]')!.click();
      await until(() => !!exported);
      const read = await readProjectFile(exported!);
      assert(exportedName.endsWith('.folio'), `exported as ${exportedName}`);
      assert(
        read.project.assets.length === 1 && read.assets.size === 1,
        'unused assets exported',
      );
      assert(shell.editor.project.assets.length === 2, 'export mutated editor');
    });
    await test('a failed image autosave still exports the in-memory bytes', async () => {
      const save = storage.saveProject.bind(storage);
      const read = storage.assetBytes.bind(storage);
      try {
        storage.saveProject = async () => {
          throw new DOMException('Full', 'QuotaExceededError');
        };
        storage.assetBytes = async () => {
          throw new DOMException('Closed', 'InvalidStateError');
        };
        shell.editor.edit(({ tree }) => {
          tree.setProjectName(shell.editor.project.name + ' edited');
        });
        await delegate.flush();
        assert(!node('save-banner').hidden, 'save failure not shown');
        exported = undefined;
        document.querySelector<HTMLElement>('[data-export-now]')!.click();
        await until(() => !!exported);
        const loaded = await readProjectFile(exported!);
        assert(
          loaded.assets.size === 1 &&
            loaded.project.name === shell.editor.project.name,
          'failed-save export lost work',
        );
      } finally {
        storage.saveProject = save;
        storage.assetBytes = read;
        await delegate.flush();
      }
    });
    await test('export, delete, and import restores the Project and its illustrations under a fresh ID', async () => {
      await delegate.flush();
      const expected = (await readProjectFile(exported!)).project;
      await storage.deleteProject(record.id);
      // The stored export is authoritative, so load a clean desk before import.
      shell.editor.replaceProject(createProject('Empty'));
      shell.redraw();
      drop(
        node('projects-window'),
        new File([exported! as Uint8Array<ArrayBuffer>], 'saved.folio'),
      );
      await until(() => shell.editor.project.name === expected.name);
      assert(
        JSON.stringify(serializeProject(shell.editor.project)) ===
          JSON.stringify(serializeProject(expected)),
        'Project changed in round trip',
      );
      assert(
        node('page').querySelectorAll('img').length === 2,
        'images missing after import',
      );
      const records = await storage.listProjects();
      assert(
        records.some(r => r.title === expected.name && r.id !== record.id),
        'import reused ID',
      );
    });
    await test('a Project file exported as .zip before the app was named still imports', async () => {
      const before = (await storage.listProjects()).length;
      drop(
        node('projects-window'),
        new File([exported! as Uint8Array<ArrayBuffer>], 'earlier.zip'),
      );
      await until(async () => (await storage.listProjects()).length > before);
    });
    await test('damaged and newer imports leave the current Project unchanged', async () => {
      const before = JSON.stringify(shell.editor.project);
      drop(node('projects-window'), new File(['broken'], 'broken.zip'));
      await until(() =>
        node('notice-text').textContent!.includes("Couldn't import"),
      );
      assert(
        JSON.stringify(shell.editor.project) === before,
        'broken file replaced Project',
      );
      const newer = await writeZip([
        {
          name: 'project.json',
          data: new TextEncoder().encode(
            JSON.stringify({
              ...serializeProject(shell.editor.project),
              format: 999,
            }),
          ),
        },
      ]);
      drop(
        node('projects-window'),
        new File([newer as Uint8Array<ArrayBuffer>], 'newer.zip'),
      );
      await until(() =>
        node('notice-text').textContent!.includes('newer version'),
      );
      assert(
        JSON.stringify(shell.editor.project) === before,
        'newer file replaced Project',
      );
    });
    await test('missing assets open as placeholders with Replace and survive re-export', async () => {
      const missing = thaw<Project>(shell.editor.project);
      missing.name = 'Missing asset browser check';
      const file = await writeProjectFile(missing, new Map(), {
        allowMissing: true,
      });
      // A fresh cache simulates opening on a different machine.
      shell.images.dispose();
      // Remove stored copies so loading does not legitimately recover shared bytes.
      for (const item of await storage.listProjects()) {
        if (item.title.startsWith('Image browser check')) {
          await storage.deleteProject(item.id);
        }
      }
      drop(
        node('projects-window'),
        new File([file as Uint8Array<ArrayBuffer>], 'missing.zip'),
      );
      await until(() => shell.editor.project.name === missing.name);
      assert(
        node('page').textContent!.includes('Missing image'),
        'missing placeholder absent',
      );
      assert(
        node('page').querySelector('[data-replace-image]'),
        'Replace absent',
      );
      exported = undefined;
      document.querySelector<HTMLElement>('[data-export-now]')!.click();
      await until(() => !!exported);
      assert(
        (await readProjectFile(exported!)).missingAssets.length === 1,
        'missing reference lost',
      );
    });
  } finally {
    HTMLAnchorElement.prototype.click = nativeClick;
    URL.createObjectURL = nativeUrl;
    lock.release();
    for (const item of await storage.listProjects()) {
      if (
        item.title.startsWith('Image browser check') ||
        item.title === 'Missing asset browser check'
      ) {
        await storage.deleteProject(item.id);
      }
    }
  }
  return results;
};
