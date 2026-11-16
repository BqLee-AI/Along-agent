export function refreshTasks() {
  return window.fetch('/tasks');
}
