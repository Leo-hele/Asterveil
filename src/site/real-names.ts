import type { Scope } from '../core/scope';
import { graduationLabel } from '../features/real-names/labels';
import { realNames } from '../features/real-names/users';

// Only profile links; /user/<id>/friend and other subpages keep their own labels.
const userHref = /^\/user\/(\d+)\/?(?:[?#].*)?$/;
const anchorSelector = 'a[href^="/user/"]';

type TextChange = { readonly node: Text; readonly original: string };
type MoveChange = { readonly node: Element; readonly parent: Element; readonly next: Node | null };
type TitleChange = { readonly previous: string | null; readonly value: string };
type Change = {
  readonly texts: readonly TextChange[];
  readonly replacement: string;
  readonly moves: readonly MoveChange[];
  readonly title?: TitleChange;
};

function anchorsOf(root: Node): readonly HTMLAnchorElement[] {
  if (root instanceof Element || root instanceof DocumentFragment || root instanceof Document) {
    return Array.from(root.querySelectorAll<HTMLAnchorElement>(anchorSelector));
  }
  return [];
}

// Prefer the link's own text; fall back to nested text so wrapper spans still resolve.
function textNodesOf(anchor: HTMLAnchorElement): readonly Text[] {
  const direct = Array.from(anchor.childNodes).filter(
    (node): node is Text => node.nodeType === Node.TEXT_NODE,
  );
  if (direct.some((node) => node.data.trim())) return direct;
  const walker = document.createTreeWalker(anchor, NodeFilter.SHOW_TEXT);
  const nested: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    nested.push(node as Text);
  }
  return nested.filter((node) => node.data.trim());
}

function follows(reference: Node, node: Node): boolean {
  return (reference.compareDocumentPosition(node) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0;
}

// Avatars rendered after the name move in front of it, matching the usual 7FA4 layout.
function moveAvatarBefore(anchor: HTMLAnchorElement, name: Text): MoveChange | undefined {
  const sibling = anchor.nextElementSibling;
  const avatar =
    anchor.querySelector('img') ?? (sibling instanceof HTMLImageElement ? sibling : undefined);
  if (!avatar || !follows(name, avatar)) return;
  const parent = avatar.parentNode;
  if (!(parent instanceof Element)) return;
  const change: MoveChange = { node: avatar, parent, next: avatar.nextSibling };
  if (anchor.contains(avatar)) name.before(avatar);
  else anchor.before(avatar);
  return change;
}

// Profile links carry the 7FA4 user id, so the nickname in the link can become the real name.
export function replaceUserNames(scope: Scope): void {
  const applied = new Map<HTMLAnchorElement, Change>();
  const checked = new WeakSet<HTMLAnchorElement>();
  const apply = (anchor: HTMLAnchorElement) => {
    if (checked.has(anchor)) return;
    const href = anchor.getAttribute('href');
    const id = href ? userHref.exec(href)?.[1] : undefined;
    if (!id) return;
    const entry = realNames[id];
    // The table is bundled, so unknown ids stay unknown for the whole page lifetime.
    if (!entry?.name) {
      checked.add(anchor);
      return;
    }
    const texts = textNodesOf(anchor);
    const [first, ...rest] = texts;
    if (!first) return;
    const current = texts.map((node) => node.data).join('').trim();
    if (!current || current === entry.name) return;
    checked.add(anchor);
    const changes = texts.map((node) => ({ node, original: node.data }));
    first.data = entry.name;
    for (const node of rest) node.data = '';
    const move = moveAvatarBefore(anchor, first);
    const label = graduationLabel(entry.title);
    let title: TitleChange | undefined;
    if (label) {
      // Graduation shows on hover, so the table keeps its original width.
      const previous = anchor.getAttribute('title');
      title = { previous, value: label };
      anchor.setAttribute('title', label);
    }
    applied.set(anchor, {
      texts: changes,
      replacement: entry.name,
      moves: move ? [move] : [],
      ...(title ? { title } : {}),
    });
  };
  const scan = (root: Node) => {
    if (root instanceof HTMLAnchorElement) apply(root);
    for (const anchor of anchorsOf(root)) apply(anchor);
  };

  let frame = 0;
  const update = () => {
    frame = 0;
    scan(document);
  };
  const observer = new MutationObserver(() => {
    if (!frame) frame = requestAnimationFrame(update);
  });
  observer.observe(document, { childList: true, subtree: true });
  scan(document);

  scope.defer(() => {
    observer.disconnect();
    if (frame) cancelAnimationFrame(frame);
    for (const [anchor, change] of applied) {
      // Preserve any later change made by the site or another extension.
      const current = change.texts.map(({ node }) => node.data).join('').trim();
      if (current !== change.replacement) continue;
      for (const { node, original } of change.texts) node.data = original;
      const title = change.title;
      if (title && anchor.getAttribute('title') === title.value) {
        if (title.previous === null) anchor.removeAttribute('title');
        else anchor.setAttribute('title', title.previous);
      }
      for (const { node, parent, next } of change.moves) {
        if (next?.parentNode === parent) parent.insertBefore(node, next);
        else parent.append(node);
      }
    }
    applied.clear();
  });
}
