'use client';

import { Moon, Sun } from 'lucide-react';
import { headerIconClass } from './header-icon';
import { useThemeMode } from './app-theme';

export function ThemeToggle({ className }: { className?: string }) {
  const { mode, toggle } = useThemeMode();
  const label = mode === 'dark' ? '切换到浅色模式' : '切换到深色模式';
  return (
    <button
      type="button"
      className={`${headerIconClass} ${className ?? ''}`}
      aria-label={label}
      title={label}
      onClick={(event) => {
        const box = event.currentTarget.getBoundingClientRect();
        toggle({ x: box.left + box.width / 2, y: box.top + box.height / 2 });
      }}
    >
      {mode === 'dark' ? (
        <Sun className="size-4" aria-hidden="true" />
      ) : (
        <Moon className="size-4" aria-hidden="true" />
      )}
    </button>
  );
}
