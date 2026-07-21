// Shared API client for the ScrapForAI UI.
//
// The API key is NEVER stored in JavaScript or localStorage. Authentication is a
// httpOnly SameSite=Strict cookie issued by POST /v1/auth/login, so this code cannot
// read the credential even if it wanted to.

const UI_HEADER = 'X-ScrapForAI-UI';

export async function apiFetch(pathname, options = {}) {
  const headers = new Headers(options.headers ?? {});

  // Required by the server's CSRF check on cookie-authenticated state changes.
  headers.set(UI_HEADER, '1');
  if (options.body && !headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  const response = await fetch(pathname, { ...options, headers, credentials: 'same-origin' });

  if (response.status === 401 && !pathname.startsWith('/v1/auth/')) {
    window.location.href = '/ui/login.html';
    throw new Error('Not authenticated');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : null;

  if (!response.ok) {
    const message = payload?.error?.message ?? `Request failed (${response.status})`;
    const error = new Error(message);
    error.details = payload?.error?.details ?? [];
    throw error;
  }

  return payload;
}

export function formatDuration(ms) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`;
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatDateTime(iso) {
  if (!iso) return '—';
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString();
}

export function formatBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = bytes;
  let unitIndex = 0;
  while (value >= 1024 && unitIndex < units.length - 1) {
    value /= 1024;
    unitIndex += 1;
  }
  return `${value.toFixed(value >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

/** Always build DOM via textContent, never innerHTML, so run data cannot inject markup. */
export function el(tag, attributes = {}, children = []) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attributes)) {
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
    else node.setAttribute(key, value);
  }
  for (const child of [].concat(children)) {
    if (child) node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function markActiveNav() {
  const current = window.location.pathname.split('/').pop() || 'index.html';
  for (const link of document.querySelectorAll('header.topbar nav a')) {
    if (link.getAttribute('href') === current) link.classList.add('active');
  }
}

export async function logout() {
  await apiFetch('/v1/auth/logout', { method: 'POST' }).catch(() => {});
  window.location.href = '/ui/login.html';
}
