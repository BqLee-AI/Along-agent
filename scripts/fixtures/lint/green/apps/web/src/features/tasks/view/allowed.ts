export function localAdapter(service: { fetch(): string }) {
  return service.fetch();
}
