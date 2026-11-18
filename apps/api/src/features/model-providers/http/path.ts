export function isModelProviderPath(pathname: string): boolean {
  return (
    pathname === '/api/v1/model-providers' ||
    pathname.startsWith('/api/v1/model-providers/') ||
    pathname === '/api/v1/model-selection/actions/set-default'
  );
}
