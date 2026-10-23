import { fontCss, layoutCss } from 'virtual:homework-katex';
import type { Scope } from '../core/scope';
import type { ChatApi } from '../features/chat/api';
import { createChatApi } from '../features/chat/api';
import type {
  ChatConversation,
  ChatLimits,
  ChatMessage,
  ChatScope,
  ChatToken,
} from '../features/chat/model';
import { filterConversations, formatTime, mergeMessages } from '../features/chat/model';
import { realNames } from '../features/real-names/users';
import { renderMarkdown } from '../features/homework/markdown';
import markdownCss from '../features/homework/markdown.css?inline';
import css from './chat-app.css?inline';

const refreshInterval = 5_000;
const draftStoreKey = 'asterveil:chat:drafts';
const longMessage = 20_000;

interface ChatState {
  conversations: ChatConversation[];
  byKey: Map<string, ChatConversation>;
  activeKey: string;
  messages: Map<string, readonly ChatMessage[]>;
  hasOlder: Map<string, boolean>;
  drafts: Record<string, string>;
  selfId: number;
  limits: ChatLimits;
  token: ChatToken;
  scope: ChatScope;
  query: string;
  loading: boolean;
}

function element<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function storedName(id: number): string | undefined {
  return realNames[String(id)]?.name;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function withRealNames(conversations: readonly ChatConversation[]): ChatConversation[] {
  return conversations.map((conversation) => ({
    ...conversation,
    name:
      conversation.type === 'user'
        ? (storedName(conversation.id) ?? conversation.name)
        : conversation.name,
    members: conversation.members.map((member) => ({
      ...member,
      name: storedName(member.id) ?? member.name,
    })),
  }));
}

function messageSignature(messages: readonly ChatMessage[]): string {
  const last = messages[messages.length - 1];
  const pending = messages.filter((message) => message.sendState).map((message) => message.id);
  return `${messages.length}:${last?.id ?? ''}:${pending.join(',')}`;
}

function nearBottom(container: HTMLElement): boolean {
  return container.scrollHeight - container.scrollTop - container.clientHeight < 80;
}

export function mountChatPage(scope: Scope): void {
  const original = document.querySelector<HTMLElement>('#chat-app');
  if (!original || scope.signal.aborted) return;

  const api: ChatApi = createChatApi();
  const state: ChatState = {
    conversations: [],
    byKey: new Map(),
    activeKey: '',
    messages: new Map(),
    hasOlder: new Map(),
    drafts: {},
    selfId: Number.NaN,
    limits: { count: 20, length: Number.POSITIVE_INFINITY, recover: null },
    token: {},
    scope: 'all',
    query: '',
    loading: false,
  };

  const host = document.createElement('section');
  host.dataset.asterveilChat = '';
  const shadow = host.attachShadow({ mode: 'open' });
  const style = element('style');
  style.textContent = `${layoutCss}\n${markdownCss}\n${css}`;
  const shell = buildShell();
  shadow.append(style, shell);
  const previousDisplay = original.style.display;
  original.style.display = 'none';
  original.before(host);

  const fonts = element('style');
  fonts.dataset.asterveil = 'chat-fonts';
  fonts.textContent = fontCss;
  document.head.append(fonts);

  const get = <T extends Element>(selector: string) => shell.querySelector<T>(selector) as T;
  const conversationsEl = get<HTMLElement>('.conversations');
  const emptyEl = get<HTMLElement>('.empty');
  const titleEl = get<HTMLElement>('.title');
  const metaEl = get<HTMLElement>('.meta');
  const statusEl = get<HTMLElement>('.status');
  const messagesEl = get<HTMLElement>('.messages');
  const inputEl = get<HTMLTextAreaElement>('.input');
  const counterEl = get<HTMLElement>('.counter');
  const tokenEl = get<HTMLElement>('.token');
  const sendEl = get<HTMLButtonElement>('.send');
  const searchEl = get<HTMLInputElement>('.search');
  const tabsEl = get<HTMLElement>('.tabs');

  let frame = 0;
  let draftTimer = 0;
  let timer = 0;
  let disposed = false;

  const current = (): ChatConversation | undefined =>
    state.activeKey ? state.byKey.get(state.activeKey) : undefined;

  function setStatus(text: string, level: 'info' | 'success' | 'error' = 'info'): void {
    statusEl.textContent = text;
    statusEl.dataset.level = level;
  }

  function draftKey(): string {
    return `${draftStoreKey}:${Number.isFinite(state.selfId) && state.selfId > 0 ? `u${state.selfId}` : 'anonymous'}`;
  }

  function loadDrafts(): void {
    try {
      const raw = localStorage.getItem(draftKey());
      const parsed: unknown = raw ? JSON.parse(raw) : {};
      state.drafts = {};
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === 'string' && value) state.drafts[key] = value.slice(0, 200_000);
        }
      }
    } catch {
      state.drafts = {};
    }
  }

  function persistDrafts(): void {
    try {
      localStorage.setItem(draftKey(), JSON.stringify(state.drafts));
    } catch {
      // Drafts are best effort; a full quota must not break sending.
    }
  }

  function saveDraft(key: string, value: string): void {
    if (!key) return;
    if (value) state.drafts[key] = value.slice(0, 200_000);
    else delete state.drafts[key];
    window.clearTimeout(draftTimer);
    draftTimer = window.setTimeout(persistDrafts, 250);
  }

  function senderName(message: ChatMessage): string {
    if (message.isSelf) return '我';
    const conversation = current();
    if (conversation?.type === 'group') {
      return (
        storedName(message.senderId) ??
        conversation.members.find((member) => member.id === message.senderId)?.name ??
        `用户 ${message.senderId}`
      );
    }
    return conversation?.name ?? storedName(message.senderId) ?? `用户 ${message.senderId}`;
  }

  function messageRow(message: ChatMessage): HTMLElement {
    const row = element('div', `message${message.isSelf ? ' self' : ''}`);
    const avatar = element(
      'span',
      'avatar',
      message.isSelf ? '我' : (senderName(message).charAt(0) || '?'),
    );
    const main = element('div', 'message-main');
    const meta = element('div', 'message-meta');
    meta.append(element('strong', undefined, senderName(message)));
    meta.append(element('span', undefined, formatTime(message.time)));
    if (message.sendState === 'pending') meta.append(element('span', 'state', '发送中'));
    const bubble = element('div', 'bubble');
    const paper = element('article', 'paper chat-paper');
    bubble.append(paper);
    if (message.content.length <= longMessage) {
      try {
        renderMarkdown(message.content, paper, { chat: true });
      } catch {
        paper.textContent = message.content;
      }
    } else {
      paper.textContent = message.content;
    }
    main.append(meta, bubble);
    if (message.sendState === 'failed') {
      row.classList.add('failed');
      const actions = element('div', 'message-actions');
      const retry = element('button', 'ghost', '重发');
      retry.type = 'button';
      retry.dataset.action = 'retry';
      retry.dataset.id = message.localId ?? '';
      const discard = element('button', 'ghost', '移除');
      discard.type = 'button';
      discard.dataset.action = 'discard';
      discard.dataset.id = message.localId ?? '';
      actions.append(retry, discard);
      main.append(actions);
    }
    row.append(avatar, main);
    return row;
  }

  function renderMessages(options: { bottom?: boolean; preserveScroll?: boolean } = {}): void {
    const conversation = current();
    const previousHeight = messagesEl.scrollHeight;
    const previousTop = messagesEl.scrollTop;
    const wasNearBottom = nearBottom(messagesEl);
    messagesEl.replaceChildren();
    if (!conversation) {
      messagesEl.append(element('p', 'empty-thread', '选择一个会话开始聊天'));
      return;
    }
    const messages = state.messages.get(conversation.key) ?? [];
    if (!messages.length) {
      messagesEl.append(element('p', 'empty-thread', '还没有消息，发送第一条试试'));
    } else {
      if (state.hasOlder.get(conversation.key) !== false) {
        const wrap = element('div', 'load-older');
        const button = element('button', 'ghost', '加载更早消息');
        button.type = 'button';
        button.dataset.action = 'older';
        wrap.append(button);
        messagesEl.append(wrap);
      }
      for (const message of messages) messagesEl.append(messageRow(message));
    }
    if (options.bottom || (wasNearBottom && !options.preserveScroll)) {
      messagesEl.scrollTop = messagesEl.scrollHeight;
    } else if (options.preserveScroll) {
      messagesEl.scrollTop = Math.max(0, previousTop + messagesEl.scrollHeight - previousHeight);
    }
  }

  function renderConversations(): void {
    conversationsEl.replaceChildren();
    const list = filterConversations(state.conversations, state.scope, state.query);
    for (const conversation of list) {
      const item = element(
        'button',
        `conversation${conversation.key === state.activeKey ? ' is-active' : ''}`,
      );
      item.type = 'button';
      item.dataset.key = conversation.key;
      const avatar = element(
        'span',
        `avatar${conversation.type === 'group' ? ' group' : ''}`,
        conversation.type === 'group' ? '群' : (conversation.name.charAt(0) || '?'),
      );
      const body = element('span', 'conversation-body');
      const top = element('span', 'conversation-top');
      top.append(element('strong', undefined, conversation.name));
      top.append(
        element('span', 'kind', conversation.type === 'group' ? '群聊' : '私聊'),
      );
      const latest = state.messages.get(conversation.key)?.at(-1);
      const preview = element(
        'span',
        'conversation-preview',
        latest
          ? `${latest.isSelf ? '我: ' : ''}${latest.content.replace(/\s+/g, ' ').slice(0, 80)}`
          : conversation.subtitle,
      );
      body.append(top, preview);
      item.append(avatar, body);
      conversationsEl.append(item);
    }
    emptyEl.hidden = list.length > 0;
    emptyEl.textContent = state.conversations.length ? '没有匹配的会话' : '暂无会话，请检查登录状态后刷新';
  }

  function renderHeader(): void {
    const conversation = current();
    if (!conversation) {
      titleEl.textContent = '请选择会话';
      metaEl.textContent = '同步会话后可开始聊天';
      return;
    }
    titleEl.textContent = conversation.name;
    const type = conversation.type === 'group' ? '群聊' : '私聊';
    const recover =
      state.limits.recover !== null ? ` · Token ${state.limits.recover}s 恢复` : '';
    metaEl.textContent = `${type} · ID ${conversation.id}${recover}`;
  }

  function renderToken(): void {
    const remain = state.token.remain ?? '--';
    const used = state.token.used;
    tokenEl.textContent = `Token: ${used ?? '--'} 已用 / ${remain} 剩余`;
  }

  function renderComposer(): void {
    const conversation = current();
    inputEl.disabled = !conversation;
    sendEl.disabled = !conversation || !inputEl.value.trim();
    const limit = Number.isFinite(state.limits.length) ? state.limits.length : '--';
    counterEl.textContent = `${inputEl.value.length} / ${limit}`;
    counterEl.classList.toggle(
      'is-overflow',
      Number.isFinite(state.limits.length) && inputEl.value.length > state.limits.length,
    );
  }

  function renderAll(options: { bottom?: boolean } = {}): void {
    renderConversations();
    renderHeader();
    renderMessages(options);
    renderToken();
    renderComposer();
  }

  function selectConversation(key: string): void {
    if (!state.byKey.has(key)) return;
    const previous = current();
    if (previous) saveDraft(previous.key, inputEl.value);
    state.activeKey = key;
    inputEl.value = state.drafts[key] ?? '';
    renderConversations();
    renderHeader();
    renderMessages({ bottom: true });
    renderComposer();
    inputEl.focus({ preventScroll: true });
    void loadActive({ bottom: true });
  }

  async function loadActive(options: { silent?: boolean; before?: number; bottom?: boolean } = {}): Promise<void> {
    const conversation = current();
    if (!conversation || state.loading) return;
    state.loading = true;
    if (!options.silent) setStatus(options.before ? '正在加载更早消息…' : '正在刷新消息…');
    try {
      const fetched = await api.messages(conversation, state.selfId, {
        take: state.limits.count,
        ...(options.before !== undefined ? { before: options.before } : {}),
      });
      if (disposed || scope.signal.aborted) return;
      const key = conversation.key;
      const existing = state.messages.get(key) ?? [];
      const merged = mergeMessages(existing, fetched);
      const changed = messageSignature(existing) !== messageSignature(merged);
      state.messages.set(key, merged);
      if (options.before !== undefined && !fetched.length) state.hasOlder.set(key, false);
      if (!options.silent) {
        setStatus(fetched.length ? `已更新 ${fetched.length} 条消息` : '暂无新消息', 'success');
      }
      if (key === state.activeKey && changed) {
        renderMessages({ bottom: options.bottom === true, preserveScroll: options.before !== undefined });
        renderConversations();
      }
    } catch (error) {
      if (!disposed) setStatus(`刷新失败：${errorText(error)}`, 'error');
    } finally {
      state.loading = false;
    }
  }

  async function send(): Promise<void> {
    const conversation = current();
    if (!conversation) return;
    const content = inputEl.value;
    if (!content.trim()) {
      setStatus('消息不能为空', 'error');
      return;
    }
    if (Number.isFinite(state.limits.length) && content.length > state.limits.length) {
      setStatus(`消息长度超过限制：${content.length} / ${state.limits.length}`, 'error');
      return;
    }
    const localId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const pending: ChatMessage = {
      id: localId,
      localId,
      conversationKey: conversation.key,
      senderId: state.selfId,
      targetId: conversation.id,
      content,
      time: Math.floor(Date.now() / 1000),
      isSelf: true,
      sendState: 'pending',
    };
    const key = conversation.key;
    state.messages.set(key, mergeMessages(state.messages.get(key) ?? [], [pending]));
    inputEl.value = '';
    saveDraft(key, '');
    renderMessages({ bottom: true });
    renderConversations();
    renderComposer();
    setStatus('正在发送…');
    try {
      const result = await api.send(conversation, state.selfId, content);
      if (disposed) return;
      state.token = { ...state.token, ...result.token };
      const remaining = (state.messages.get(key) ?? []).filter((message) => message.localId !== localId);
      state.messages.set(key, mergeMessages(remaining, result.messages));
      setStatus('已发送', 'success');
      renderMessages({ bottom: true });
      renderConversations();
      renderToken();
      void loadActive({ silent: true, bottom: true });
    } catch (error) {
      if (disposed) return;
      const messages = state.messages.get(key) ?? [];
      state.messages.set(
        key,
        messages.map((message) =>
          message.localId === localId ? { ...message, sendState: 'failed' } : message,
        ),
      );
      setStatus(`发送失败：${errorText(error)}`, 'error');
      renderMessages({ bottom: true });
    }
    renderComposer();
  }

  async function retry(id: string): Promise<void> {
    const conversation = current();
    const message = (state.messages.get(conversation?.key ?? '') ?? []).find(
      (item) => item.localId === id,
    );
    if (!conversation || !message) return;
    state.messages.set(
      conversation.key,
      (state.messages.get(conversation.key) ?? []).filter((item) => item.localId !== id),
    );
    inputEl.value = message.content;
    renderComposer();
    await send();
  }

  function discard(id: string): void {
    const key = state.activeKey;
    if (!key) return;
    state.messages.set(
      key,
      (state.messages.get(key) ?? []).filter((item) => item.localId !== id),
    );
    renderMessages();
    renderConversations();
  }

  async function refreshToken(): Promise<void> {
    setStatus('正在查询 Token…');
    try {
      state.token = { ...state.token, ...(await api.token()) };
      if (disposed) return;
      renderToken();
      setStatus('Token 已更新', 'success');
    } catch (error) {
      if (!disposed) setStatus(`Token 查询失败：${errorText(error)}`, 'error');
    }
  }

  async function sync(): Promise<void> {
    setStatus('正在同步会话…');
    try {
      const snapshot = await api.info();
      if (disposed || scope.signal.aborted) return;
      state.selfId = snapshot.selfId;
      state.limits = snapshot.limits;
      state.token = { ...snapshot.token };
      state.conversations = withRealNames(snapshot.conversations);
      state.byKey = new Map(state.conversations.map((conversation) => [conversation.key, conversation]));
      loadDrafts();
      if (!state.byKey.has(state.activeKey)) {
        state.activeKey = state.conversations[0]?.key ?? '';
        inputEl.value = state.drafts[state.activeKey] ?? '';
      }
      renderAll({ bottom: true });
      setStatus(
        state.conversations.length ? `已同步 ${state.conversations.length} 个会话` : '没有可用的会话',
        state.conversations.length ? 'success' : 'error',
      );
      if (state.activeKey) await loadActive({ silent: true, bottom: true });
    } catch (error) {
      if (!disposed) {
        setStatus(`同步失败：${errorText(error)}`, 'error');
        renderConversations();
      }
    }
  }

  function onMessagesClick(event: MouseEvent): void {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const action = target.closest<HTMLElement>('[data-action]')?.dataset.action;
    if (action === 'older') {
      const conversation = current();
      const oldest = conversation ? (state.messages.get(conversation.key) ?? [])[0] : undefined;
      if (oldest && Number.isFinite(oldest.time)) void loadActive({ before: oldest.time });
      return;
    }
    if (action === 'retry') {
      const id = target.closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id) void retry(id);
      return;
    }
    if (action === 'discard') {
      const id = target.closest<HTMLElement>('[data-id]')?.dataset.id;
      if (id) discard(id);
    }
  }

  conversationsEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const key = target.closest<HTMLElement>('[data-key]')?.dataset.key;
    if (key) selectConversation(key);
  });
  messagesEl.addEventListener('click', onMessagesClick);
  tabsEl.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element)) return;
    const tab = target.closest<HTMLElement>('[data-scope]');
    if (!tab) return;
    state.scope = (tab.dataset.scope as ChatScope) ?? 'all';
    for (const item of tabsEl.querySelectorAll<HTMLElement>('[data-scope]')) {
      const active = item.dataset.scope === state.scope;
      item.classList.toggle('is-active', active);
      item.setAttribute('aria-selected', String(active));
    }
    renderConversations();
  });
  searchEl.addEventListener('input', () => {
    state.query = searchEl.value;
    renderConversations();
  });
  inputEl.addEventListener('input', () => {
    renderComposer();
    saveDraft(state.activeKey, inputEl.value);
  });
  inputEl.addEventListener('keydown', (event) => {
    if (event.key !== 'Enter' || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    if (!sendEl.disabled) void send();
  });
  sendEl.addEventListener('click', () => void send());
  shell.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement)) return;
    const action = target.dataset.action;
    if (action === 'refresh') void loadActive();
    if (action === 'token') void refreshToken();
  });
  const onVisibilityChange = () => {
    if (!document.hidden) void loadActive({ silent: true });
  };
  document.addEventListener('visibilitychange', onVisibilityChange);

  scope.defer(() => {
    disposed = true;
    window.clearInterval(timer);
    window.clearTimeout(frame);
    window.clearTimeout(draftTimer);
    document.removeEventListener('visibilitychange', onVisibilityChange);
    if (state.activeKey && inputEl.value) saveDraft(state.activeKey, inputEl.value);
    persistDrafts();
    fonts.remove();
    host.remove();
    original.style.display = previousDisplay;
  });

  timer = window.setInterval(() => {
    if (document.hidden) return;
    void loadActive({ silent: true });
  }, refreshInterval);
  frame = window.setTimeout(() => {
    void sync();
  }, 0);
}

function buildShell(): HTMLElement {
  const chat = element('div', 'chat');
  chat.innerHTML = `<aside class="sidebar" aria-label="会话列表">
    <div class="sidebar-head">
      <input class="search" type="search" placeholder="搜索会话 / ID" aria-label="搜索会话">
    </div>
    <div class="tabs" role="tablist" aria-label="会话类型">
      <button type="button" class="tab is-active" data-scope="all" role="tab" aria-selected="true">全部</button>
      <button type="button" class="tab" data-scope="user" role="tab" aria-selected="false">私聊</button>
      <button type="button" class="tab" data-scope="group" role="tab" aria-selected="false">群聊</button>
    </div>
    <div class="conversations" role="list" aria-live="polite"></div>
    <p class="empty" hidden>暂无会话</p>
  </aside>
  <section class="main" aria-label="聊天内容">
    <header class="main-head">
      <div class="identity">
        <div class="title">请选择会话</div>
        <div class="meta">同步会话后可开始聊天</div>
      </div>
      <div class="head-actions">
        <button type="button" class="ghost" data-action="token" title="查询 Token 用量">Token</button>
        <button type="button" class="ghost" data-action="refresh" title="刷新当前会话">刷新</button>
      </div>
    </header>
    <p class="status" role="status" aria-live="polite"></p>
    <div class="messages" role="log" aria-live="polite"></div>
    <div class="composer">
      <textarea class="input" rows="3" placeholder="输入消息，Enter 发送，Shift+Enter 换行" aria-label="消息内容"></textarea>
      <div class="composer-foot">
        <span class="token">Token: -- / --</span>
        <span class="counter">0 / --</span>
        <button type="button" class="send" data-action="send">发送</button>
      </div>
    </div>
  </section>`;
  return chat;
}
