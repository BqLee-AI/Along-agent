export function directRequests() {
  fetch('/tasks');
  window.fetch('/tasks');
  globalThis.fetch('/tasks');
  return <div />;
}
