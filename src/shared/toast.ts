/** 轻量提示条：单例，复用同一个 DOM 节点。 */

let node: HTMLDivElement | undefined;
let timer: ReturnType<typeof setTimeout> | undefined;

function ensureNode(): HTMLDivElement {
  if (!node) {
    node = document.createElement('div');
    node.className = 'toast';
    document.body.append(node);
  }
  return node;
}

/** 显示一条提示（默认 1.4 秒后淡出）。 */
export function toast(message: string, ms = 1400): void {
  const box = ensureNode();
  box.textContent = message;
  box.classList.add('show');
  if (timer !== undefined) clearTimeout(timer);
  timer = setTimeout(() => box.classList.remove('show'), ms);
}
