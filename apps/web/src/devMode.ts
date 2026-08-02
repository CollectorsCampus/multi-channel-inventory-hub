import { useCallback, useSyncExternalStore } from 'react';

/**
 * "Developer mode": show the screens that are normally reached from somewhere
 * specific rather than from the top navigation.
 *
 * `/match` and `/list` act on **one channel** and are setup tasks rather than
 * daily ones, so each is linked from the place it applies to. That is the right
 * default and stays the default — but it also means someone who knows a screen
 * exists has no way to get to it without remembering the URL, which is the
 * complaint this answers.
 *
 * ## A preference, not a permission
 *
 * This reveals links. It grants nothing: every one of those routes is guarded
 * server-side by role, and turning it on for a viewer produces pages that
 * explain they cannot be used. Anyone could already reach them by typing the
 * path, so hiding the links was never a security measure and this does not
 * weaken one.
 *
 * ## Why localStorage rather than the URL or the server
 *
 * It is a fact about how one person likes to navigate, not about what they are
 * looking at — so it must not travel when a filtered view is shared, which
 * rules out the URL. And it is not worth a column: a per-user server setting
 * would need a migration, an endpoint and a cache, to remember a checkbox.
 * Same reasoning as the inventory table's card-art toggle.
 *
 * ## Why `useSyncExternalStore` and not `useState`
 *
 * There are two readers — the nav in `AppShell` and the toggle on the settings
 * page — and with `useState` each held its **own** copy. Ticking the box wrote
 * localStorage and re-rendered the settings page while the nav went on showing
 * the old links, because the `storage` event deliberately does not fire in the
 * tab that caused it. The toggle looked broken while being perfectly correct
 * in isolation, which is why this is a single module-level store every
 * consumer subscribes to rather than per-component state.
 */

const STORAGE_KEY = 'hub.devMode';

const listeners = new Set<() => void>();

function read(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'true';
  } catch {
    // Private browsing, or storage disabled. The feature degrades to "off",
    // which is the normal state — it must never be the reason a page fails.
    return false;
  }
}

/**
 * Cached because `useSyncExternalStore` calls the snapshot on every render and
 * compares by identity: reading localStorage each time is both needless work
 * and, for a value that is not a primitive, a re-render loop waiting to happen.
 */
let snapshot = read();

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  // Another tab. Its write does not reach us any other way, and two tabs open
  // is normal for a tool like this.
  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = read();
    emit();
  };
  window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function getSnapshot(): boolean {
  return snapshot;
}

export function useDevMode(): [boolean, (next: boolean) => void] {
  const enabled = useSyncExternalStore(subscribe, getSnapshot);

  const set = useCallback((next: boolean) => {
    snapshot = next;
    try {
      window.localStorage.setItem(STORAGE_KEY, String(next));
    } catch {
      // The toggle still works for this session; it just will not be remembered.
    }
    emit();
  }, []);

  return [enabled, set];
}
