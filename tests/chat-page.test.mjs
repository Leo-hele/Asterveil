import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const origin = 'https://jx.7fa4.cn:8888';

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
        setTimeout,
        clearTimeout,
        setInterval,
        clearInterval,
        require(name) {
          if (name === 'virtual:homework-katex') return { fontCss: '', layoutCss: '' };
          if (name.endsWith('?inline')) return { default: '' };
          return name.startsWith('.') ? load(resolve(dirname(path), `${name}.ts`)) : require(name);
        },
        ...globals,
      },
    );
    return exports;
  }
  return load;
}

function json(value) {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify(value),
  };
}

function fixture() {
  const { document, window } = parseHTML(
    '<html><body><div class="ui main container"><div id="chat-app"><div id="chat-messages"></div></div></div></body></html>',
  );
  const requests = [];
  const fetch = async (url, options = {}) => {
    const href = String(url);
    const target = new URL(href);
    requests.push({ url: href, options, type: target.searchParams.get('type') });
    if (target.pathname === '/chat/info') {
      return json({
        success: true,
        data: {
          user: { id: 7 },
          limit: { count_limit: 20, message_length_limit: 1000 },
          friends: [{ source_id: 7, target_id: 12, real_name: '张三' }],
          groups: [{ id: 5, title: '竞赛组', users: [{ id: 7 }] }],
        },
      });
    }
    if (target.pathname === '/chat/chat' && target.searchParams.get('type') === 'user') {
      return json({ chat: [{ id: 1, sender_id: 12, content: 'hi', time: 1000 }] });
    }
    if (target.pathname === '/chat/chat' && options.method === 'POST') {
      return json({
        success: true,
        chat: [{ id: 100, sender_id: 7, target_id: 12, content: 'hello', time: 2000 }],
        used_token_count: 1,
        remain_token_count: 99,
      });
    }
    return json({ chat: [] });
  };
  const store = new Map();
  const local = loader({
    document,
    window: {
      setTimeout,
      clearTimeout,
      setInterval,
      clearInterval,
      prompt: () => null,
      confirm: () => false,
    },
    Node: window.Node,
    NodeFilter: { SHOW_TEXT: 4 },
    Element: window.Element,
    Document: window.Document,
    DocumentFragment: window.DocumentFragment,
    MutationObserver: window.MutationObserver,
    fetch,
    location: { origin },
    localStorage: {
      getItem: (key) => store.get(key) ?? null,
      setItem: (key, value) => store.set(key, String(value)),
      removeItem: (key) => store.delete(key),
    },
  });
  const { Scope } = local('src/core/scope.ts');
  const scope = new Scope();
  local('src/site/chat-page.ts').mountChatPage(scope);
  const host = document.querySelector('[data-asterveil-chat]');
  return { document, window, scope, host, root: host.shadowRoot, requests };
}

test('the chat room replaces the site view and renders conversations', async () => {
  const { document, host, root, requests, scope } = fixture();
  const original = document.querySelector('#chat-app');
  assert.equal(host.previousElementSibling, null);
  assert.equal(original.style.display, 'none');
  await setImmediate();
  assert.ok(requests.some((item) => item.url.includes('/chat/info')));
  const items = root.querySelectorAll('.conversation');
  assert.equal(items.length, 2);
  assert.equal(root.querySelector('.conversation.is-active') !== null, true);
  assert.equal(root.querySelector('.title').textContent, '竞赛组');
  scope.dispose();
  assert.equal(document.querySelector('[data-asterveil-chat]'), null);
  assert.equal(document.querySelector('#chat-app').style.display, '');
});

test('selecting a conversation loads messages and sending posts the text', async () => {
  const { window, root, requests, scope } = fixture();
  await setImmediate();
  const userItem = Array.from(root.querySelectorAll('.conversation')).find((item) =>
    item.dataset.key.startsWith('user:'),
  );
  userItem.dispatchEvent(new window.Event('click', { bubbles: true }));
  await setImmediate();
  assert.ok(requests.some((item) => item.url.includes('type=user')));
  const input = root.querySelector('.input');
  input.value = 'hello';
  input.dispatchEvent(new window.Event('input', { bubbles: true }));
  root.querySelector('.send').dispatchEvent(new window.Event('click', { bubbles: true }));
  await setImmediate();
  const post = requests.find((item) => item.options.method === 'POST');
  assert.ok(post);
  assert.match(post.options.body, /content=hello/);
  assert.match(post.options.body, /target_id=12/);
  assert.match(post.options.body, /type=user/);
  scope.dispose();
});

test('group management lists members and posts group actions', async () => {
  const { window, root, requests, scope } = fixture();
  window.prompt = () => '新名字';
  window.confirm = () => true;
  await setImmediate();
  const groupItem = Array.from(root.querySelectorAll('.conversation')).find((item) =>
    item.dataset.key.startsWith('group:'),
  );
  groupItem.dispatchEvent(new window.Event('click', { bubbles: true }));
  await setImmediate();
  const panel = root.querySelector('.group-panel');
  assert.equal(panel.hidden, true);
  root.querySelector('[data-action="group"]').dispatchEvent(new window.Event('click', { bubbles: true }));
  assert.equal(panel.hidden, false);
  assert.equal(root.querySelectorAll('.group-member').length, 1);
  const rename = Array.from(root.querySelectorAll('.group-actions button')).find(
    (button) => button.textContent === '修改群名',
  );
  rename.dispatchEvent(new window.Event('click', { bubbles: true }));
  await setImmediate();
  const post = requests.filter((item) => item.url.includes('/chat/group')).at(-1);
  assert.ok(post);
  assert.match(post.options.body, /type=set_title/);
  assert.match(post.options.body, /group_id=5/);
  assert.match(post.options.body, /title=/);
  scope.dispose();
});
