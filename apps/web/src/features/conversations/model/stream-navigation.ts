type LeaveRequest = (leave: () => void) => void;
type TraversalEvent = Event & {
  navigationType: string;
  destination: { key: string; url: string; sameDocument: boolean };
};
type TraversalNavigation = EventTarget & {
  traverseTo: (key: string) => { finished: Promise<unknown> };
};

function browserNavigation() {
  return (window as Window & { navigation?: TraversalNavigation }).navigation;
}

export function isSameReadingPage(left: string, right: string): boolean {
  const a = new URL(left);
  const b = new URL(right);
  return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
}

function position(state: unknown): number | null {
  if (typeof state !== 'object' || state === null || !('__alongHistoryPosition' in state))
    return null;
  const value = state.__alongHistoryPosition;
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : null;
}

let legacy: {
  request: LeaveRequest | null;
  shouldLeave: ((url: string) => boolean) | null;
} | null = null;

// Older browsers need positions recorded before any client-side navigation.
// The tracker belongs to this document, not to an individual streamed Run.
export function prepareHistoryNavigation(): void {
  if (browserNavigation() || legacy) return;
  const tracker = {
    request: null as LeaveRequest | null,
    shouldLeave: null as ((url: string) => boolean) | null,
  };
  legacy = tracker;
  const history = window.history;
  const push = history.pushState.bind(history);
  const replace = history.replaceState.bind(history);
  let current = position(history.state) ?? 0;
  let currentUrl = location.href;
  let restoring = false;
  let permitted = false;
  const tagged = (state: unknown, value: number) => ({
    ...(typeof state === 'object' && state !== null ? state : {}),
    __alongHistoryPosition: value,
  });
  replace(tagged(history.state, current), '', location.href);
  let currentState: unknown = history.state;
  history.pushState = (state: unknown, unused: string, url?: string | URL | null) => {
    push(tagged(state, current + 1), unused, url);
    current++;
    currentUrl = location.href;
    currentState = history.state;
  };
  history.replaceState = (state: unknown, unused: string, url?: string | URL | null) => {
    replace(tagged(state, current), unused, url);
    currentUrl = location.href;
    currentState = history.state;
  };
  window.addEventListener(
    'popstate',
    (event: PopStateEvent) => {
      const target = position(event.state);
      // Native fragment navigation also creates an entry, without pushState.
      if (
        (target === null || target === current) &&
        location.href !== currentUrl &&
        isSameReadingPage(location.href, currentUrl)
      ) {
        current++;
        currentUrl = location.href;
        replace(tagged(currentState, current), '', currentUrl);
        currentState = history.state;
        return;
      }
      if (target === null) return; // Entries from another document use beforeunload.
      if (restoring) {
        restoring = false;
        current = target;
        currentUrl = location.href;
        currentState = history.state;
        event.stopImmediatePropagation();
        return;
      }
      if (
        !permitted &&
        tracker.request &&
        !isSameReadingPage(location.href, currentUrl) &&
        (!tracker.shouldLeave || tracker.shouldLeave(location.href))
      ) {
        event.stopImmediatePropagation();
        const delta = target - current;
        restoring = true;
        history.go(-delta);
        tracker.request(() => {
          permitted = true;
          history.go(target - current);
        });
        return;
      }
      permitted = false;
      current = target;
      currentUrl = location.href;
      currentState = history.state;
    },
    true,
  );
}

export function watchHistoryNavigation(
  request: LeaveRequest,
  shouldLeave: (url: string) => boolean = () => true,
): () => void {
  const navigation = browserNavigation();
  if (!navigation) {
    prepareHistoryNavigation();
    const tracker = legacy;
    if (!tracker) return () => {};
    tracker.request = request;
    tracker.shouldLeave = shouldLeave;
    return () => {
      if (tracker.request === request) {
        tracker.request = null;
        tracker.shouldLeave = null;
      }
    };
  }
  let permitted = false;
  const traverse = (event: Event) => {
    const traversal = event as TraversalEvent;
    if (
      permitted ||
      traversal.navigationType !== 'traverse' ||
      !traversal.destination.sameDocument ||
      !event.cancelable ||
      isSameReadingPage(traversal.destination.url, location.href) ||
      !shouldLeave(traversal.destination.url)
    )
      return;
    // Cancel before committing: the stream and current history entry stay intact.
    // The destination key preserves Forward, Back and multi-entry traversals.
    event.preventDefault();
    const key = traversal.destination.key;
    request(() => {
      permitted = true;
      void navigation.traverseTo(key).finished.catch(() => {
        permitted = false;
      });
    });
  };
  navigation.addEventListener('navigate', traverse);
  return () => navigation.removeEventListener('navigate', traverse);
}
