'use client';

import { createContext, useCallback, useContext, useMemo, useState } from 'react';
import type { ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { LumenProvider } from '@lorelum/lumen-ui/themes';
import { domAnimation, LazyMotion, MotionConfig } from 'motion/react';
import { THEME_COOKIE, type ThemeMode } from './theme-mode';

export interface ThemeOrigin {
  x: number;
  y: number;
}

interface ThemeControl {
  mode: ThemeMode;
  toggle: (origin?: ThemeOrigin) => void;
}

const ThemeControlContext = createContext<ThemeControl | null>(null);

export function useThemeMode(): ThemeControl {
  const value = useContext(ThemeControlContext);
  if (!value) throw new Error('useThemeMode 必须在 AppTheme 内使用');
  return value;
}

export function AppTheme({
  children,
  initialMode,
}: {
  children: ReactNode;
  initialMode: ThemeMode;
}) {
  const [mode, setMode] = useState(initialMode);
  const toggle = useCallback(
    (origin?: ThemeOrigin) => {
      const next: ThemeMode = mode === 'dark' ? 'light' : 'dark';
      const apply = () => {
        document.documentElement.classList.toggle('dark', next === 'dark');
        document.cookie = `${THEME_COOKIE}=${next}; path=/; max-age=31536000; samesite=lax`;
        flushSync(() => setMode(next));
      };
      if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
        apply();
        return;
      }
      const x = origin?.x ?? window.innerWidth / 2;
      const y = origin?.y ?? window.innerHeight / 2;
      const radius = Math.hypot(
        Math.max(x, window.innerWidth - x),
        Math.max(y, window.innerHeight - y),
      );
      // 变深：一块深色的布从按钮处向外盖满页面；变亮：一团光从按钮处向外铺满页面。
      // 页面在被盖住时才真正换主题，再让布淡去。整页位图过渡实测每帧 50–100ms，遮罩只合成一层，帧率稳定。
      const cover = document.createElement('div');
      cover.setAttribute('aria-hidden', 'true');
      Object.assign(cover.style, {
        position: 'fixed',
        inset: '0',
        zIndex: '2147483000',
        overflow: 'hidden',
        pointerEvents: 'none',
      });
      // 圆本身只做 transform 缩放，由合成器处理，比逐帧重绘 clip-path 更稳。
      const disc = document.createElement('div');
      Object.assign(disc.style, {
        position: 'absolute',
        left: `${x - radius}px`,
        top: `${y - radius}px`,
        width: `${radius * 2}px`,
        height: `${radius * 2}px`,
        borderRadius: '50%',
        background: next === 'dark' ? '#151517' : '#fafafb',
        transform: 'scale(0)',
        willChange: 'transform',
      });
      cover.append(disc);
      document.body.append(cover);
      const root = document.documentElement;
      void (async () => {
        try {
          await disc.animate(
            { transform: ['scale(0)', 'scale(1)'] },
            {
              duration: next === 'dark' ? 560 : 480,
              easing:
                next === 'dark'
                  ? 'cubic-bezier(0.65, 0, 0.35, 1)'
                  : 'cubic-bezier(0.22, 1, 0.36, 1)',
              fill: 'forwards',
            },
          ).finished;
          root.classList.add('theme-switching');
          apply();
          const painted = Promise.withResolvers<void>();
          requestAnimationFrame(() => requestAnimationFrame(() => painted.resolve()));
          await painted.promise;
          root.classList.remove('theme-switching');
          await cover.animate(
            { opacity: [1, 0] },
            { duration: 420, easing: 'ease-out', fill: 'forwards' },
          ).finished;
        } finally {
          cover.remove();
        }
      })();
    },
    [mode],
  );
  const control = useMemo(() => ({ mode, toggle }), [mode, toggle]);
  return (
    <ThemeControlContext value={control}>
      <LumenProvider mode={mode} className="min-h-dvh bg-background text-foreground">
        <LazyMotion features={domAnimation}>
          <MotionConfig reducedMotion="user">{children}</MotionConfig>
        </LazyMotion>
      </LumenProvider>
    </ThemeControlContext>
  );
}
