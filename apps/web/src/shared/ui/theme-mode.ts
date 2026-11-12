export type ThemeMode = 'light' | 'dark';

export const THEME_COOKIE = 'along-theme';

export function parseThemeMode(value: string | undefined): ThemeMode {
  return value === 'dark' ? 'dark' : 'light';
}
