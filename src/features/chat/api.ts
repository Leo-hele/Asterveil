import type {
  ChatConversation,
  ChatMessage,
  ChatSnapshot,
  ChatToken,
  GroupAction,
  GroupExtra,
} from './model';
import { groupPayload, parseInfo, parseMessages, parseToken } from './model';

const requestTimeout = 12_000;

type Params = Readonly<Record<string, string | number | null | undefined>>;

interface RequestOptions {
  readonly params?: Params;
  readonly data?: Params;
}

export interface ChatApi {
  info(): Promise<ChatSnapshot>;
  messages(
    conversation: ChatConversation,
    selfId: number,
    options?: { before?: number; take?: number },
  ): Promise<readonly ChatMessage[]>;
  send(
    conversation: ChatConversation,
    selfId: number,
    content: string,
  ): Promise<{ messages: readonly ChatMessage[]; token: ChatToken }>;
  group(action: GroupAction, groupId: number | null, extra?: GroupExtra): Promise<void>;
  token(): Promise<ChatToken>;
}

function buildUrl(path: string, params?: Params): string {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params ?? {})) {
    if (value === null || value === undefined || value === '') continue;
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function formBody(data: Params | undefined): string {
  const body = new URLSearchParams();
  for (const [key, value] of Object.entries(data ?? {})) {
    if (value === null || value === undefined) continue;
    body.append(key, String(value));
  }
  return body.toString();
}

// The chat UI reads exactly the endpoints Better Names used; the official API remains authoritative.
export function createChatApi(fetcher: typeof fetch = fetch): ChatApi {
  async function request(
    method: 'GET' | 'POST',
    path: string,
    options: RequestOptions = {},
  ): Promise<unknown> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), requestTimeout);
    try {
      const response = await fetcher(buildUrl(path, options.params), {
        method,
        cache: 'no-store',
        credentials: 'include',
        signal: controller.signal,
        ...(method === 'POST'
          ? {
              headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
              body: formBody(options.data),
            }
          : {}),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      let payload: unknown;
      try {
        payload = JSON.parse(text || '{}');
      } catch {
        throw new Error('接口返回不是合法 JSON');
      }
      if (!payload || typeof payload !== 'object') throw new Error('接口返回格式错误');
      if ('success' in payload && payload.success === false) {
        const error = 'err' in payload ? payload.err : undefined;
        const message =
          error && typeof error === 'object' && 'message' in error && typeof error.message === 'string'
            ? error.message
            : '未知错误';
        throw new Error(message);
      }
      return payload;
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') throw new Error('请求超时');
      throw error;
    } finally {
      clearTimeout(timer);
    }
  }

  return {
    async info() {
      return parseInfo(await request('GET', '/chat/info'));
    },
    async messages(conversation, selfId, options = {}) {
      const take = Math.max(1, Math.min(options.take ?? 20, 100));
      const base: Record<string, number> = { target_id: conversation.id, take };
      if (options.before !== undefined && Number.isFinite(options.before)) {
        base.end_time = Math.max(0, Math.floor(options.before) - 1);
      }
      if (conversation.type === 'group') {
        const payload = await request('GET', '/chat/chat', {
          params: { ...base, type: 'group' },
        });
        return parseMessages(payload, conversation, 'group', selfId);
      }
      const [received, sent] = await Promise.all([
        request('GET', '/chat/chat', { params: { ...base, type: 'user' } }),
        request('GET', '/chat/chat', { params: { ...base, type: 'send' } }),
      ]);
      return [
        ...parseMessages(received, conversation, 'in', selfId),
        ...parseMessages(sent, conversation, 'out', selfId),
      ].sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
    },
    async send(conversation, selfId, content) {
      const payload = await request('POST', '/chat/chat', {
        data: { type: conversation.type, target_id: conversation.id, content },
      });
      return {
        messages: parseMessages(
          payload,
          conversation,
          conversation.type === 'group' ? 'group' : 'out',
          selfId,
        ),
        token: parseToken(payload),
      };
    },
    async group(action, groupId, extra = {}) {
      await request('POST', '/chat/group', { data: groupPayload(action, groupId, extra) });
    },
    async token() {
      return parseToken(await request('POST', '/chat/chat', { data: { type: 'none' } }));
    },
  };
}
