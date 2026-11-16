export function edgeRequests() {
  fetch?.('/tasks');
  window?.fetch('/tasks');
  window.fetch?.('/tasks');
  globalThis['fetch']('/tasks');
  window['fetch']('/tasks');
  (fetch)('/tasks');
  (globalThis.fetch)('/tasks');
}
