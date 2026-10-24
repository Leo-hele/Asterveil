// Pure chat payload normalisation. Kept free of DOM and fetch so the page UI stays testable.

export type ChatScope = 'all' | 'user' | 'group';

export interface ChatConversation {
  readonly key: string;
  readonly type: 'user' | 'group';
  readonly id: number;
  readonly name: string;
  readonly subtitle: string;
  readonly members: readonly ChatMember[];
  readonly activity: number;
}

export interface ChatMember {
  readonly id: number;
  readonly name: string;
  readonly role: string;
}

export type ChatMessageKind = 'text' | 'vote' | 'pat';

export interface ChatMessageBody {
  readonly kind: ChatMessageKind;
  readonly text: string;
  readonly pollId: string;
  readonly picks: readonly string[];
  readonly targetId: number;
}

export interface ChatMessage {
  readonly id: string;
  readonly conversationKey: string;
  readonly senderId: number;
  readonly targetId: number;
  readonly content: string;
  readonly body: ChatMessageBody;
  readonly time: number;
  readonly isSelf: boolean;
  readonly localId?: string;
  readonly sendState?: 'pending' | 'failed';
}

export interface ChatLimits {
  readonly count: number;
  readonly length: number;
  readonly recover: number | null;
}

export interface ChatToken {
  readonly used?: number;
  readonly remain?: number;
}

export interface ChatSnapshot {
  readonly conversations: readonly ChatConversation[];
  readonly selfId: number;
  readonly limits: ChatLimits;
  readonly token: ChatToken;
}

export type MessageDirection = 'in' | 'out' | 'group';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function toInteger(value: unknown): number {
  if (typeof value === 'number') return Number.isSafeInteger(value) ? value : Number.NaN;
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const parsed = Number.parseInt(value, 10);
  return Number.isSafeInteger(parsed) ? parsed : Number.NaN;
}

function pickInteger(source: Record<string, unknown>, keys: readonly string[]): number {
  for (const key of keys) {
    const parsed = toInteger(source[key]);
    if (Number.isFinite(parsed)) return parsed;
  }
  return Number.NaN;
}

function pickText(
  source: Record<string, unknown>,
  keys: readonly string[],
  fallback = '',
): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return fallback;
}

function pickArray(source: unknown, keys: readonly string[]): readonly unknown[] {
  if (Array.isArray(source)) return source;
  if (!isRecord(source)) return [];
  for (const key of keys) {
    const value = source[key];
    if (Array.isArray(value)) return value;
  }
  return [];
}

// Documents differ in whether payloads nest under data/result; accept both shapes.
export function payloadRoot(payload: unknown): Record<string, unknown> {
  if (!isRecord(payload)) return {};
  const data = payload.data ?? payload.result;
  return isRecord(data) ? data : payload;
}

export function normalizeTime(value: unknown): number {
  if (typeof value === 'number') {
    if (!Number.isFinite(value) || value <= 0) return Number.NaN;
    return Math.floor(value > 1e12 ? value / 1000 : value);
  }
  if (typeof value !== 'string' || !value.trim()) return Number.NaN;
  const raw = value.trim();
  if (/^\d+(?:\.\d+)?$/.test(raw)) return normalizeTime(Number(raw));
  const parsed = Date.parse(raw.includes('T') ? raw : raw.replace(' ', 'T'));
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : Number.NaN;
}

function activityOf(source: Record<string, unknown>): number {
  for (const key of [
    'last_message_time',
    'lastMessageTime',
    'last_message_at',
    'lastMessageAt',
    'last_chat_time',
    'lastChatTime',
    'latest_message_time',
    'latestMessageTime',
    'updated_at',
    'updatedAt',
    'timestamp',
    'send_time',
    'time',
  ]) {
    const time = normalizeTime(source[key]);
    if (Number.isFinite(time)) return time;
  }
  return Number.NaN;
}

// Chat payloads also carry votes and pats as JSON envelopes; turn them into readable parts.
export function parseMessageBody(value: unknown): ChatMessageBody {
  const base: ChatMessageBody = {
    kind: 'text',
    text: value == null ? '' : String(value),
    pollId: '',
    picks: [],
    targetId: Number.NaN,
  };
  let payload: Record<string, unknown> | undefined;
  if (isRecord(value)) payload = value;
  else if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
      try {
        const parsed: unknown = JSON.parse(trimmed);
        if (isRecord(parsed)) payload = parsed;
      } catch {
        // Ordinary chat text can look JSON-like; keep it unchanged when parsing fails.
      }
    }
  }
  if (!payload) return base;
  if (payload.type === 'text' && typeof payload.content === 'string') {
    return { ...base, text: payload.content };
  }
  if (payload.type === 'vote') {
    return {
      kind: 'vote',
      text: typeof payload.custom === 'string' ? payload.custom : '',
      pollId: payload.poll == null ? '' : String(payload.poll),
      picks: Array.isArray(payload.pick) ? payload.pick.map((item) => String(item)) : [],
      targetId: Number.NaN,
    };
  }
  if (payload.type === 'pat') {
    return { ...base, kind: 'pat', targetId: toInteger(payload.target) };
  }
  return base;
}

export function messageContent(value: unknown): string {
  const body = parseMessageBody(value);
  if (body.kind === 'text') return body.text;
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function friendIdOf(friend: Record<string, unknown>, selfId: number): number {
  const nested = isRecord(friend.user) ? friend.user : {};
  const source = pickInteger(friend, ['source_id', 'sourceId', 'from_id', 'fromId', 'sender_id']);
  const target = pickInteger(friend, ['target_id', 'targetId', 'to_id', 'toId', 'receiver_id']);
  if (Number.isFinite(selfId)) {
    if (source === selfId && Number.isFinite(target)) return target;
    if (target === selfId && Number.isFinite(source)) return source;
  }
  for (const candidate of [
    target,
    source,
    pickInteger(friend, ['friend_id', 'friendId', 'other_id', 'otherId', 'user_id', 'userId']),
    pickInteger(friend, ['uid']),
    pickInteger(nested, ['id', 'user_id', 'uid']),
    pickInteger(friend, ['id']),
  ]) {
    if (Number.isFinite(candidate) && candidate > 0) return candidate;
  }
  return Number.NaN;
}

export function parseInfo(
  payload: unknown,
  names: Readonly<Record<string, string>> = {},
): ChatSnapshot {
  const root = payloadRoot(payload);
  const limit = isRecord(root.limit) ? root.limit : {};
  const user =
    [root.user, root.self, root.me, root.profile].find((item) => isRecord(item)) ?? {};
  const selfId = pickInteger(user, ['id', 'user_id', 'uid']);
  const conversations: ChatConversation[] = [];
  const seen = new Set<string>();
  const displayName = (id: number, source: Record<string, unknown>, fallback: string): string => {
    const stored = names[String(id)];
    if (stored) return stored;
    return pickText(source, ['real_name', 'realName', 'nickname', 'name', 'username'], fallback);
  };
  const push = (conversation: ChatConversation) => {
    if (seen.has(conversation.key)) return;
    seen.add(conversation.key);
    conversations.push(conversation);
  };

  for (const raw of pickArray(root, ['friends', 'friend', 'users', 'contacts'])) {
    if (!isRecord(raw)) continue;
    const id = friendIdOf(raw, selfId);
    if (!Number.isFinite(id) || id <= 0 || id === selfId) continue;
    // One-way friends expose no real_name and cannot receive a conversation.
    if (!pickText(raw, ['real_name', 'realName'])) continue;
    push({
      key: `user:${id}`,
      type: 'user',
      id,
      name: displayName(id, raw, `用户 ${id}`),
      subtitle: `私聊 · ID ${id}`,
      members: [],
      activity: activityOf(raw),
    });
  }

  for (const raw of pickArray(root, ['groups', 'group'])) {
    if (!isRecord(raw)) continue;
    const id = pickInteger(raw, ['id', 'group_id', 'groupId']);
    if (!Number.isFinite(id) || id <= 0) continue;
    const members: ChatMember[] = [];
    for (const member of pickArray(raw, ['users', 'members', 'member'])) {
      if (!isRecord(member)) continue;
      const memberId = pickInteger(member, ['id', 'user_id', 'uid']);
      if (!Number.isFinite(memberId) || memberId <= 0) continue;
      members.push({
        id: memberId,
        name: displayName(memberId, member, `用户 ${memberId}`),
        role: pickText(member, ['type', 'role', 'role_type', 'roleType'], ''),
      });
    }
    push({
      key: `group:${id}`,
      type: 'group',
      id,
      name: pickText(raw, ['title', 'name', 'group_name', 'groupName'], `群组 ${id}`),
      subtitle: `群聊 · ${members.length} 人 · ID ${id}`,
      members,
      activity: activityOf(raw),
    });
  }

  conversations.sort(compareConversations);
  const count = pickInteger(limit, ['count_limit', 'countLimit', 'message_count_limit']);
  const length = pickInteger(limit, ['message_length_limit', 'length_limit', 'lengthLimit']);
  const recover = pickInteger(limit, ['recover_time', 'recoverTime']);
  return {
    conversations,
    selfId,
    limits: {
      count: Number.isFinite(count) && count > 0 ? count : 20,
      length: Number.isFinite(length) && length > 0 ? length : Number.POSITIVE_INFINITY,
      recover: Number.isFinite(recover) && recover >= 0 ? recover : null,
    },
    token: parseToken(payload),
  };
}

export function compareConversations(a: ChatConversation, b: ChatConversation): number {
  if (a.activity !== b.activity) {
    if (!Number.isFinite(a.activity)) return 1;
    if (!Number.isFinite(b.activity)) return -1;
    return b.activity - a.activity;
  }
  if (a.type !== b.type) return a.type === 'group' ? -1 : 1;
  return a.name.localeCompare(b.name, 'zh-Hans-CN');
}

function chatItems(payload: unknown): readonly unknown[] {
  if (Array.isArray(payload)) return payload;
  const root = payloadRoot(payload);
  for (const key of ['chat', 'chats', 'messages', 'message', 'records', 'list', 'items']) {
    const value = root[key];
    if (Array.isArray(value)) return value;
    if (isRecord(value)) return [value];
  }
  return [];
}

interface NormalizeOptions {
  readonly selfId: number;
  readonly conversation: ChatConversation;
  readonly direction: MessageDirection;
}

export function normalizeMessage(raw: unknown, options: NormalizeOptions): ChatMessage | null {
  if (!isRecord(raw)) return null;
  const peer = pickInteger(raw, ['user_id', 'userId', 'uid', 'friend_id', 'friendId']);
  let senderId = pickInteger(raw, [
    'sender_id',
    'senderId',
    'from_id',
    'fromId',
    'source_id',
    'sourceId',
    'user_id',
    'userId',
    'uid',
  ]);
  let targetId = pickInteger(raw, [
    'target_id',
    'targetId',
    'to_id',
    'toId',
    'receiver_id',
    'receiverId',
    'group_id',
    'groupId',
    'dest_id',
    'destId',
  ]);
  if (!Number.isFinite(senderId) && Number.isFinite(options.selfId)) {
    if (options.direction === 'out') senderId = options.selfId;
    if (options.direction === 'in') senderId = options.conversation.id;
  }
  if (!Number.isFinite(targetId)) {
    if (options.direction === 'out') targetId = options.conversation.id;
    if (options.direction === 'in' && Number.isFinite(options.selfId)) targetId = options.selfId;
    if (options.direction === 'group') targetId = options.conversation.id;
  }
  if (!Number.isFinite(senderId) && Number.isFinite(peer)) senderId = peer;
  const rawContent = raw.content ?? raw.message ?? raw.text ?? raw.body_md ?? raw.body;
  const body = parseMessageBody(rawContent);
  const content = messageContent(rawContent);
  if (!content.trim()) return null;
  const time = normalizeTime(
    raw.timestamp ?? raw.send_time ?? raw.sendTime ?? raw.time ?? raw.created_at ?? raw.createdAt,
  );
  const isSelf =
    options.direction === 'out' ||
    (Number.isFinite(options.selfId) && senderId === options.selfId);
  const rawId = raw.id ?? raw.chat_id ?? raw.chatId ?? raw.message_id ?? raw.messageId ?? raw.mid;
  const id =
    rawId != null && String(rawId).trim()
      ? `${options.conversation.key}:${options.direction}:${String(rawId)}`
      : `${options.conversation.key}:${options.direction}:${senderId}:${targetId}:${time}:${content}`;
  return {
    id,
    conversationKey: options.conversation.key,
    senderId,
    targetId,
    content,
    body,
    time,
    isSelf,
  };
}

export function parseMessages(
  payload: unknown,
  conversation: ChatConversation,
  direction: MessageDirection,
  selfId: number,
): readonly ChatMessage[] {
  const messages: ChatMessage[] = [];
  for (const raw of chatItems(payload)) {
    const message = normalizeMessage(raw, { selfId, conversation, direction });
    if (!message) continue;
    if (belongsToConversation(message, conversation, direction, selfId)) messages.push(message);
  }
  return messages.sort(compareMessages);
}

// The chat endpoint can return neighbouring conversations; keep only this thread's messages.
export function belongsToConversation(
  message: ChatMessage,
  conversation: ChatConversation,
  direction: MessageDirection,
  selfId: number,
): boolean {
  if (conversation.type === 'group') return message.targetId === conversation.id;
  const selfKnown = Number.isFinite(selfId);
  if (direction === 'out' || message.isSelf) {
    if (message.targetId !== conversation.id) return false;
    return !selfKnown || !Number.isFinite(message.senderId) || message.senderId === selfId;
  }
  if (message.senderId !== conversation.id) return false;
  return !selfKnown || !Number.isFinite(message.targetId) || message.targetId === selfId;
}

export function compareMessages(a: ChatMessage, b: ChatMessage): number {
  if (Number.isFinite(a.time) && Number.isFinite(b.time) && a.time !== b.time) return a.time - b.time;
  if (Number.isFinite(a.time) !== Number.isFinite(b.time)) {
    return Number.isFinite(a.time) ? -1 : 1;
  }
  return a.id.localeCompare(b.id);
}

// Fetched windows overlap; keep one entry per id and drop optimistic echoes of sent text.
export function mergeMessages(
  existing: readonly ChatMessage[],
  incoming: readonly ChatMessage[],
): readonly ChatMessage[] {
  const merged = [...existing];
  for (const message of incoming) {
    const echo = merged.findIndex((item) => isLocalEcho(item, message));
    if (echo >= 0) {
      const current = merged[echo];
      if (current) {
        merged[echo] = current.localId ? { ...message, localId: current.localId } : message;
      }
      continue;
    }
    const index = merged.findIndex((item) => item.id === message.id);
    if (index >= 0) {
      const current = merged[index];
      if (current) {
        merged[index] = current.localId
          ? { ...current, ...message, localId: current.localId }
          : { ...current, ...message };
      }
    } else {
      merged.push(message);
    }
  }
  const byId = new Map<string, ChatMessage>();
  for (const message of merged) byId.set(message.id, message);
  return [...byId.values()].sort(compareMessages).slice(-500);
}

function isLocalEcho(local: ChatMessage, incoming: ChatMessage): boolean {
  if (!local.localId || incoming.localId) return false;
  if (local.content !== incoming.content) return false;
  if (local.isSelf !== incoming.isSelf) return false;
  if (!Number.isFinite(local.time) || !Number.isFinite(incoming.time)) return true;
  return Math.abs(local.time - incoming.time) <= 15;
}

export function filterConversations(
  conversations: readonly ChatConversation[],
  scope: ChatScope,
  query: string,
): readonly ChatConversation[] {
  const needle = query.trim().toLowerCase();
  return conversations.filter((conversation) => {
    if (scope !== 'all' && conversation.type !== scope) return false;
    if (!needle) return true;
    return [conversation.name, conversation.subtitle, String(conversation.id), conversation.key].some(
      (value) => value.toLowerCase().includes(needle),
    );
  });
}

export function parseToken(payload: unknown): ChatToken {
  const root = payloadRoot(payload);
  const used = pickInteger(root, [
    'used_token_count',
    'usedTokenCount',
    'used_token',
    'usedToken',
    'used',
  ]);
  const remain = pickInteger(root, [
    'remain_token_count',
    'remainTokenCount',
    'remaining_token_count',
    'remainingTokenCount',
    'remain_token',
    'remainToken',
    'remaining',
  ]);
  return {
    ...(Number.isFinite(used) ? { used } : {}),
    ...(Number.isFinite(remain) ? { remain } : {}),
  };
}

export function formatTime(time: number): string {
  if (!Number.isFinite(time) || time <= 0) return '--:--';
  const date = new Date(time * 1000);
  const now = new Date();
  const pad = (value: number) => String(value).padStart(2, '0');
  const clock = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) return clock;
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${clock}`;
}

export function formatUnread(value: number): string {
  if (!Number.isFinite(value) || value <= 0) return '';
  return value > 99 ? '99+' : String(value);
}

export type GroupAction =
  | 'setup'
  | 'leave'
  | 'set_title'
  | 'add_member'
  | 'del_member'
  | 'add_administrator'
  | 'del_administrator'
  | 'mute_member'
  | 'mute_group'
  | 'give_owner';

export interface GroupExtra {
  readonly title?: string;
  readonly targetId?: number;
  readonly seconds?: number;
}

// Mute values are absolute timestamps, matching the official client.
export function groupPayload(
  action: GroupAction,
  groupId: number | null,
  extra: GroupExtra = {},
  now = Date.now(),
): Record<string, string | number> {
  const payload: Record<string, string | number> = { type: action };
  if (groupId !== null) payload.group_id = groupId;
  if (extra.title !== undefined) payload.title = extra.title;
  if (extra.targetId !== undefined) payload.target_id = extra.targetId;
  if (extra.seconds !== undefined) payload.mute = Math.floor(now / 1000) + extra.seconds;
  return payload;
}
