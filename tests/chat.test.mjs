import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);

function loader() {
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
        require(name) {
          return name.startsWith('.') ? load(resolve(dirname(path), `${name}.ts`)) : require(name);
        },
      },
    );
    return exports;
  }
  return load;
}

const model = loader()('src/features/chat/model.ts');

test('info payloads produce user and group conversations with limits', () => {
  const snapshot = model.parseInfo(
    {
      success: true,
      data: {
        user: { id: 7 },
        limit: { count_limit: 30, message_length_limit: 5000, recover_time: 60 },
        friends: [
          { source_id: 7, target_id: 12, real_name: '张三' },
          { source_id: 7, target_id: 13 },
          { source_id: 14, target_id: 7, real_name: '李四' },
        ],
        groups: [
          {
            id: 5,
            title: '竞赛组',
            users: [
              { id: 7, type: 'Owner' },
              { user_id: 9, type: 'Administrator' },
            ],
          },
        ],
      },
    },
    { '9': '王五' },
  );
  assert.equal(snapshot.selfId, 7);
  assert.equal(snapshot.limits.count, 30);
  assert.equal(snapshot.limits.length, 5000);
  assert.equal(snapshot.limits.recover, 60);
  assert.equal(snapshot.conversations.length, 3);
  const byKey = new Map(snapshot.conversations.map((item) => [item.key, item]));
  assert.equal(byKey.get('user:12').name, '张三');
  assert.equal(byKey.get('user:14').name, '李四');
  assert.equal(byKey.get('user:13'), undefined);
  const group = byKey.get('group:5');
  assert.equal(group.name, '竞赛组');
  assert.equal(group.members.length, 2);
  assert.equal(group.members[0].name, '用户 7');
  assert.equal(group.members[0].role, 'Owner');
  assert.equal(group.members[1].name, '王五');
  assert.equal(group.members[1].role, 'Administrator');
});

test('token counts accept nested payloads', () => {
  assert.deepEqual({ ...model.parseToken({ data: { used_token_count: 10, remain_token_count: 40 } }) }, {
    used: 10,
    remain: 40,
  });
  assert.deepEqual({ ...model.parseToken({}) }, {});
});

test('messages keep direction, sender and normalised timestamps', () => {
  const conversation = {
    key: 'user:12',
    type: 'user',
    id: 12,
    name: '张三',
    subtitle: '',
    members: [],
    activity: Number.NaN,
  };
  const received = model.parseMessages(
    { chat: [{ id: 1, sender_id: 12, content: 'hi', timestamp: '2026-10-01 10:00:00' }] },
    conversation,
    'in',
    7,
  );
  assert.equal(received.length, 1);
  assert.equal(received[0].isSelf, false);
  assert.equal(received[0].senderId, 12);
  assert.equal(received[0].targetId, 7);
  assert.equal(received[0].time, Math.floor(Date.parse('2026-10-01T10:00:00') / 1000));

  const sent = model.parseMessages(
    { chat: [{ id: 2, content: '你好', send_time: 1_750_000_000 }] },
    conversation,
    'out',
    7,
  );
  assert.equal(sent[0].isSelf, true);
  assert.equal(sent[0].senderId, 7);
  assert.equal(sent[0].targetId, 12);
  assert.equal(sent[0].time, 1_750_000_000);
});

test('group messages mark the current user and unwrap JSON text bodies', () => {
  const group = {
    key: 'group:5',
    type: 'group',
    id: 5,
    name: '竞赛组',
    subtitle: '',
    members: [],
    activity: Number.NaN,
  };
  const messages = model.parseMessages(
    {
      items: [
        { id: 9, sender_id: 7, group_id: 5, content: '{"type":"text","content":"hello"}', time: 20 },
        { id: 10, sender_id: 8, group_id: 5, content: 'plain', time: 21 },
        { id: 11, sender_id: 8, group_id: 5, content: '   ', time: 22 },
      ],
    },
    group,
    'group',
    7,
  );
  assert.equal(messages.length, 2);
  assert.equal(messages[0].isSelf, true);
  assert.equal(messages[0].content, 'hello');
  assert.equal(messages[1].isSelf, false);
  assert.equal(messages[1].content, 'plain');
});

test('merging deduplicates ids and replaces optimistic echoes', () => {
  const base = {
    id: 'a',
    conversationKey: 'user:12',
    senderId: 12,
    targetId: 7,
    content: 'x',
    time: 100,
    isSelf: false,
  };
  assert.equal(model.mergeMessages([base], [{ ...base }]).length, 1);
  const local = {
    id: 'local-1',
    localId: 'local-1',
    conversationKey: 'user:12',
    senderId: 7,
    targetId: 12,
    content: 'echo',
    time: 200,
    isSelf: true,
    sendState: 'pending',
  };
  const merged = model.mergeMessages(
    [base, local],
    [
      {
        id: 'server-9',
        conversationKey: 'user:12',
        senderId: 7,
        targetId: 12,
        content: 'echo',
        time: 202,
        isSelf: true,
      },
    ],
  );
  assert.equal(merged.length, 2);
  assert.equal(merged[1].id, 'server-9');
  assert.equal(merged[1].localId, 'local-1');
  assert.equal(merged[1].sendState, undefined);
});

test('conversation filters respect scope and search text', () => {
  const list = [
    { key: 'user:12', type: 'user', id: 12, name: '张三', subtitle: '私聊 · ID 12', members: [], activity: 2 },
    { key: 'group:5', type: 'group', id: 5, name: '竞赛组', subtitle: '群聊 · 2 人 · ID 5', members: [], activity: 3 },
  ];
  assert.equal(model.filterConversations(list, 'all', '').length, 2);
  assert.deepEqual(
    model.filterConversations(list, 'group', '').map((item) => item.key),
    ['group:5'],
  );
  assert.deepEqual(
    model.filterConversations(list, 'all', '12').map((item) => item.key),
    ['user:12'],
  );
  assert.equal(model.filterConversations(list, 'user', '竞赛').length, 0);
});

test('group actions use the official field names and absolute mute times', () => {
  const now = 1_750_000_000_000;
  assert.deepEqual({ ...model.groupPayload('set_title', 5, { title: '新群' }) }, {
    type: 'set_title',
    group_id: 5,
    title: '新群',
  });
  assert.deepEqual({ ...model.groupPayload('del_member', 5, { targetId: 9 }) }, {
    type: 'del_member',
    group_id: 5,
    target_id: 9,
  });
  assert.deepEqual({ ...model.groupPayload('mute_group', 5, { seconds: 600 }, now) }, {
    type: 'mute_group',
    group_id: 5,
    mute: 1_750_000_600,
  });
  assert.deepEqual({ ...model.groupPayload('setup', null, { title: '新群' }) }, {
    type: 'setup',
    title: '新群',
  });
  assert.deepEqual({ ...model.groupPayload('leave', 5) }, { type: 'leave', group_id: 5 });
});

test('time, unread and value helpers stay defensive', () => {
  assert.equal(model.normalizeTime(1_750_000_000_000), 1_750_000_000);
  assert.equal(model.normalizeTime('1750000000'), 1_750_000_000);
  assert.equal(model.normalizeTime(''), Number.NaN);
  assert.equal(model.formatTime(0), '--:--');
  assert.match(model.formatTime(Math.floor(Date.now() / 1000)), /^\d{2}:\d{2}$/);
  assert.equal(model.formatUnread(0), '');
  assert.equal(model.formatUnread(5), '5');
  assert.equal(model.formatUnread(150), '99+');
  assert.equal(model.messageContent('{"type":"text","content":"hello"}'), 'hello');
  assert.equal(model.messageContent('{not json}'), '{not json}');
});
