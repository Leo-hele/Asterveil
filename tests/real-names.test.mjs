import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const nodeFilter = { SHOW_TEXT: 4 };

function loader(globals = {}) {
  const cache = new Map();
  function load(path) {
    path = resolve(root, path);
    if (cache.has(path)) return cache.get(path);
    const exports = {};
    cache.set(path, exports);
    runInNewContext(
      ts.transpileModule(readFileSync(path, 'utf8'), {
        compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 },
      }).outputText,
      {
        exports,
        console,
        AbortController,
        URL,
        require(name) {
          return name.startsWith('.') ? load(resolve(dirname(path), `${name}.ts`)) : require(name);
        },
        ...globals,
      },
    );
    return exports;
  }
  return load;
}

const { realNames } = loader()('src/features/real-names/users.ts');
const { graduationLabel } = loader()('src/features/real-names/labels.ts');

const entries = Object.entries(realNames).filter(([, entry]) => entry.name);
const [yearId, yearEntry] = entries.find(([, entry]) => /^\d{4}$/.test(entry.title)) ?? entries[0];
const [hintId, hintEntry] = entries.find(([, entry]) => /^(?:by|uk|jl)$/.test(entry.title)) ?? entries[0];
const unknownId = String(Number(entries.at(-1)[0]) + 1);

function fixture(markup) {
  const { document, window } = parseHTML(`<html><body>${markup}</body></html>`);
  const frames = new Map();
  let sequence = 0;
  // linkedom omits this constant, while browsers expose it on every Node instance.
  window.Node.DOCUMENT_POSITION_FOLLOWING ??= 4;
  const local = loader({
    document,
    Node: window.Node,
    NodeFilter: nodeFilter,
    Element: window.Element,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    HTMLAnchorElement: window.HTMLAnchorElement,
    HTMLImageElement: window.HTMLImageElement,
    Text: window.Text,
    MutationObserver: window.MutationObserver,
    requestAnimationFrame: (fn) => {
      frames.set(++sequence, fn);
      return sequence;
    },
    cancelAnimationFrame: (id) => frames.delete(id),
  });
  const { Scope } = local('src/core/scope.ts');
  const scope = new Scope();
  local('src/site/real-names.ts').replaceUserNames(scope);
  return { document, scope };
}

test('link text becomes the real name, adds the graduation hint and restores on dispose', () => {
  const { document, scope } = fixture(`<a id="user" href="/user/${yearId}">nickname</a>`);
  const anchor = document.querySelector('#user');
  assert.equal(anchor.textContent, yearEntry.name);
  assert.equal(anchor.getAttribute('title'), `高中毕业：${yearEntry.title}`);
  scope.dispose();
  assert.equal(anchor.textContent, 'nickname');
  assert.equal(anchor.hasAttribute('title'), false);
});

test('avatar-only profile links receive a real name and drop it on dispose', () => {
  const { document, scope } = fixture(
    `<a id="user" href="/user/${yearId}"><img src="/avatar/${yearId}"></a>`,
  );
  const anchor = document.querySelector('#user');
  assert.equal(anchor.textContent, yearEntry.name);
  scope.dispose();
  assert.equal(anchor.textContent, '');
  assert.equal(anchor.querySelector('img').getAttribute('src'), `/avatar/${yearId}`);
});

test('links with no children at all still receive the real name and clear on dispose', () => {
  const { document, scope } = fixture(`<a id="user" href="/user/${yearId}"></a>`);
  const anchor = document.querySelector('#user');
  assert.equal(anchor.textContent, yearEntry.name);
  assert.equal(anchor.getAttribute('title'), `高中毕业：${yearEntry.title}`);
  scope.dispose();
  assert.equal(anchor.textContent, '');
  assert.equal(anchor.childNodes.length, 0);
});

test('links with an inline inherit color are left alone', () => {
  const { document } = fixture(
    `<a id="debug" href="/user/${yearId}" style="color: inherit; "></a><a id="user" href="/user/${yearId}"></a>`,
  );
  const debug = document.querySelector('#debug');
  assert.equal(debug.textContent, '');
  assert.equal(debug.hasAttribute('title'), false);
  assert.equal(document.querySelector('#user').textContent, yearEntry.name);
});

test('blank link text is reused instead of adding an empty node', () => {
  const { document, scope } = fixture(`<a id="user" href="/user/${yearId}"> </a>`);
  const anchor = document.querySelector('#user');
  assert.equal(anchor.textContent, yearEntry.name);
  assert.equal(anchor.childNodes.length, 1);
  scope.dispose();
  assert.equal(anchor.textContent, ' ');
  assert.equal(anchor.childNodes.length, 1);
});

test('an avatar rendered after the name moves in front and returns on dispose', () => {
  const { document, scope } = fixture(
    `<a id="user" href="/user/${yearId}">nickname<img src="/avatar/${yearId}"></a>`,
  );
  const anchor = document.querySelector('#user');
  const order = () => Array.from(anchor.childNodes).map((node) => node.nodeName);
  assert.deepEqual(order(), ['IMG', '#text']);
  assert.equal(anchor.lastChild.data, yearEntry.name);
  scope.dispose();
  assert.deepEqual(order(), ['#text', 'IMG']);
  assert.equal(anchor.firstChild.data, 'nickname');
});

test('cohort markers without a year keep their own hover label', () => {
  const { document } = fixture(`<a id="user" href="/user/${hintId}">nickname</a>`);
  const anchor = document.querySelector('#user');
  assert.equal(anchor.textContent, hintEntry.name);
  assert.equal(anchor.getAttribute('title'), graduationLabel(hintEntry.title));
});

test('subpages and unknown ids keep their own labels', () => {
  const { document } = fixture(
    `<a id="sub" href="/user/${yearId}/friend">friends</a><a id="unknown" href="/user/${unknownId}">nickname</a>`,
  );
  assert.equal(document.querySelector('#sub').textContent, 'friends');
  assert.equal(document.querySelector('#unknown').textContent, 'nickname');
});
