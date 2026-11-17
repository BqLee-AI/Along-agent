import type { ModelSelection, ProviderView } from '@along/contracts';

export type ModelCatalogSnapshot = {
  items: ProviderView[];
  default_selection: ModelSelection | null;
};

export function replaceCatalogProvider(
  snapshot: ModelCatalogSnapshot,
  provider: ProviderView,
  changeSelection: (current: ModelSelection | null) => ModelSelection | null = (current) => current,
): ModelCatalogSnapshot {
  return {
    items: snapshot.items.map((item) => (item.id === provider.id ? provider : item)),
    default_selection: changeSelection(snapshot.default_selection),
  };
}

export function removeCatalogProvider(
  snapshot: ModelCatalogSnapshot,
  id: string,
): ModelCatalogSnapshot {
  return {
    items: snapshot.items.filter((item) => item.id !== id),
    default_selection:
      snapshot.default_selection?.provider_id === id ? null : snapshot.default_selection,
  };
}
