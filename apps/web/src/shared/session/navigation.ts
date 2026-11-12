// Navigation carries a location only, never a saved request or action body.
const RETURN_BASE = 'http://return.internal';
const ACCOUNT_ENTRY =
  /^\/(?:login|setup|claim|logout|invite|reset-password|verify-contact|forgot-password)(?:\/|$)/i;

export type PageQuery = Record<string, string | string[] | undefined>;

function hasControlByte(value: string, includeSpace: boolean): boolean {
  const limit = includeSpace ? 33 : 32;
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code < limit || code === 127) return true;
  }
  return false;
}

export function safeReturnTo(value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith('/') || value.startsWith('//')) return '/';
  if (hasControlByte(value, false)) return '/';
  let original: URL;
  try {
    original = new URL(value, RETURN_BASE);
  } catch {
    return '/';
  }
  if (original.origin !== RETURN_BASE) return '/';
  let decoded = value.split(/[?#]/, 1)[0];
  // Inspect path encoding layers only. Query/fragment values remain opaque
  // URL data; decoding them as paths loses valid searches such as %20 or %25.
  for (let layer = 0; layer < 8; layer++) {
    if (hasControlByte(decoded, true) || /[\\?#]/.test(decoded) || decoded.startsWith('//'))
      return '/';
    if (/%(?:2f|5c)/i.test(decoded)) return '/';
    let url: URL;
    try {
      url = new URL(decoded, RETURN_BASE);
    } catch {
      return '/';
    }
    if (url.origin !== RETURN_BASE || ACCOUNT_ENTRY.test(url.pathname)) return '/';
    if (/^\/api(?:\/|$)/i.test(url.pathname)) return '/';
    let next: string;
    try {
      next = decodeURIComponent(decoded);
    } catch {
      return '/';
    }
    if (next === decoded) {
      return `${original.pathname}${original.search}${original.hash}`;
    }
    decoded = next;
  }
  return '/';
}

export function pageReturnTo(pathname: string, query: PageQuery): string {
  const params = new URLSearchParams();
  for (const [key, values] of Object.entries(query)) {
    for (const value of Array.isArray(values) ? values : values === undefined ? [] : [values]) {
      params.append(key, value);
    }
  }
  return safeReturnTo(`${pathname}${params.size ? `?${params}` : ''}`);
}

export function loginHref(returnTo: unknown): string {
  return `/login?${new URLSearchParams({ returnTo: safeReturnTo(returnTo) })}`;
}

export function protectedLoginHref(status: number, returnTo: unknown): string | null {
  return status === 401 ? loginHref(returnTo) : null;
}

export function clearAppRetryState(
  storage?: Pick<Storage, 'removeItem'> & Partial<Pick<Storage, 'length' | 'key'>>,
): void {
  try {
    const target = storage ?? (typeof window === 'undefined' ? null : window.sessionStorage);
    if (!target) return;
    const keys =
      target.key && typeof target.length === 'number'
        ? Array.from({ length: target.length }, (_, index) => target.key!(index))
        : Object.keys(target);
    for (const key of keys) {
      if (key && /^(?:run-resume:|run-cancel:|document-decision:)/.test(key)) {
        target.removeItem(key);
      }
    }
  } catch {
    // Storage may be disabled; authentication never persists an action itself.
  }
}

export function requireClientSession(response: Response): void {
  if (typeof window === 'undefined') return;
  const target = protectedLoginHref(
    response.status,
    `${window.location.pathname}${window.location.search}`,
  );
  if (!target) return;
  clearAppRetryState();
  window.location.replace(target);
  throw new Error('会话已过期，请登录。原操作不会自动重放。');
}
