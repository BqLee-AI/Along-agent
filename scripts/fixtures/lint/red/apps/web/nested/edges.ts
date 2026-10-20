export function shadow(Date: { new (...args: unknown[]): unknown; now(): number }) {
  const now = 'now';
  new Date();
  new Date('2026-10-20');
  new Date;
  new (Date)();
  Date.now();
  (Date.now)();
  Date[now]();
  Date?.now();
  Date.now?.();
}
