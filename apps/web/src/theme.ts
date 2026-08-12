import { useCallback, useSyncExternalStore } from 'react';

/**
 * Built-in colour themes.
 *
 * A theme is a named set of CSS-variable overrides in styles.css, applied by
 * stamping `data-theme` on the root element — the CSS owns every colour, and
 * this module owns only *which* palette is active. Semantic colours (the
 * error red, the pooled green) are deliberately not themed: a theme changes
 * how the app looks, never what a warning looks like.
 *
 * Stored in localStorage for the same reasons `devMode.ts` documents: it is a
 * fact about how one person likes to read the screen, not about the data, so
 * it must not travel in a URL — and it is not worth a column, an endpoint and
 * a cache to remember a dropdown. Same module-level store shape too, since
 * the settings page writes it and the whole document reads it.
 */

export const THEMES = [
  { key: 'default', label: 'Hub blue (default)' },
  { key: 'emerald', label: 'Emerald' },
  { key: 'violet', label: 'Violet' },
  { key: 'sunset', label: 'Sunset' },
] as const;

export type ThemeKey = (typeof THEMES)[number]['key'];

const STORAGE_KEY = 'hub.theme';

const listeners = new Set<() => void>();

function isThemeKey(value: string | null): value is ThemeKey {
  return THEMES.some((theme) => theme.key === value);
}

function read(): ThemeKey {
  try {
    const stored = window.localStorage.getItem(STORAGE_KEY);
    return isThemeKey(stored) ? stored : 'default';
  } catch {
    return 'default';
  }
}

let snapshot = read();

/** The CSS reads `data-theme`; absent means the default palette. */
function apply(theme: ThemeKey): void {
  if (theme === 'default') {
    delete document.documentElement.dataset.theme;
  } else {
    document.documentElement.dataset.theme = theme;
  }
}

// Applied at module load so the first paint is already themed — a flash of
// the default palette on every navigation would make the feature feel broken.
apply(snapshot);

function emit(): void {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);

  const onStorage = (event: StorageEvent) => {
    if (event.key !== STORAGE_KEY) return;
    snapshot = read();
    apply(snapshot);
    emit();
  };
  window.addEventListener('storage', onStorage);

  return () => {
    listeners.delete(listener);
    window.removeEventListener('storage', onStorage);
  };
}

function getSnapshot(): ThemeKey {
  return snapshot;
}

export function useTheme(): [ThemeKey, (next: ThemeKey) => void] {
  const theme = useSyncExternalStore(subscribe, getSnapshot);

  const set = useCallback((next: ThemeKey) => {
    snapshot = next;
    apply(next);
    try {
      window.localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Applies for this session; it just will not be remembered.
    }
    emit();
  }, []);

  return [theme, set];
}
