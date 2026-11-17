'use client';

import { useState } from 'react';
import { Boxes } from 'lucide-react';
import { m, useReducedMotion } from 'motion/react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Dialog } from '@lorelum/lumen-ui/components/dialog';
import { Input } from '@lorelum/lumen-ui/components/input';
import { Label } from '@lorelum/lumen-ui/components/label';
import { ErrorNotice } from '@/shared/ui/page';
import { validateModelId, type Provider } from '../model/model-config';

export function ModelPanel({
  provider,
  modelId,
  working,
  error,
  onSave,
  onClose,
}: {
  provider: Provider;
  modelId: string | null;
  working: boolean;
  error: string | null;
  onSave: (modelId: string, contextWindow: number | null) => Promise<boolean>;
  onClose: () => void;
}) {
  const [id, setId] = useState(modelId ?? '');
  const [windowTokens, setWindowTokens] = useState(
    modelId ? String(provider.modelContextWindows[modelId] ?? '') : '',
  );
  const [submitted, setSubmitted] = useState(false);
  const reducedMotion = useReducedMotion();
  const idError = submitted && !modelId ? validateModelId(id, provider) : null;
  const windowValue = windowTokens.trim();
  const parsed = windowValue ? Number(windowValue) : null;
  const invalidWindow = Boolean(
    windowValue && (!/^\d+$/.test(windowValue) || !Number.isSafeInteger(parsed) || parsed! < 1),
  );
  const windowError = submitted && invalidWindow ? '请输入大于 0 的整数。' : null;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open && !working) onClose();
      }}
    >
      <Dialog.Content
        data-testid="model-panel"
        className="max-w-lg overflow-hidden border border-white/40 shadow-2xl"
        style={{
          background: 'color-mix(in srgb, var(--popover) 90%, transparent)',
          backdropFilter: 'blur(32px) saturate(1.3)',
        }}
      >
        <Dialog.Header>
          <div className="flex items-center gap-3">
            <span
              aria-hidden="true"
              className="flex size-11 shrink-0 items-center justify-center rounded-2xl border border-primary/15 bg-primary/10 text-primary shadow-sm"
            >
              <Boxes className="size-5" />
            </span>
            <div className="min-w-0 space-y-1">
              <Dialog.Title className="text-base">{modelId ? '模型设置' : '添加模型'}</Dialog.Title>
              <Dialog.Description className="truncate">{provider.name}</Dialog.Description>
            </div>
          </div>
        </Dialog.Header>
        <form
          className="space-y-5"
          onSubmit={(event) => {
            event.preventDefault();
            setSubmitted(true);
            if ((!modelId && validateModelId(id, provider)) || invalidWindow) return;
            void onSave(modelId ?? id, parsed).then((ok) => {
              if (ok) onClose();
            });
          }}
        >
          <Dialog.Body className="space-y-4">
            <m.div
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: 'easeOut' }}
              className="space-y-1.5"
            >
              <Label htmlFor="model-panel-id">模型 ID</Label>
              <Input
                id="model-panel-id"
                variant="glass"
                value={id}
                readOnly={Boolean(modelId) || working}
                autoComplete="off"
                spellCheck={false}
                onChange={(event) => setId(event.target.value)}
                aria-invalid={Boolean(idError)}
                aria-describedby={idError ? 'model-panel-id-error' : undefined}
                placeholder="例如 vendor/model-name"
              />
              {idError ? (
                <p id="model-panel-id-error" className="text-sm text-destructive">
                  {idError}
                </p>
              ) : null}
            </m.div>
            <m.div
              initial={reducedMotion ? false : { opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, delay: reducedMotion ? 0 : 0.05, ease: 'easeOut' }}
              className="space-y-1.5"
            >
              <Label htmlFor="model-panel-window">上下文窗口（tokens）</Label>
              <Input
                id="model-panel-window"
                variant="glass"
                inputMode="numeric"
                value={windowTokens}
                readOnly={working}
                onChange={(event) => setWindowTokens(event.target.value)}
                aria-invalid={Boolean(windowError)}
                aria-describedby={
                  windowError ? 'model-panel-window-error' : 'model-panel-window-help'
                }
                placeholder="留空使用默认值"
              />
              <p id="model-panel-window-help" className="text-xs text-muted-foreground">
                留空使用系统默认值；保存后对新运行生效。
              </p>
              {windowError ? (
                <p id="model-panel-window-error" className="text-sm text-destructive">
                  {windowError}
                </p>
              ) : null}
            </m.div>
            {submitted && error ? <ErrorNotice message={error} /> : null}
          </Dialog.Body>
          <Dialog.Footer className="border-t border-foreground/10 pt-4">
            <Button
              type="button"
              variant="glass"
              color="default"
              disabled={working}
              onClick={onClose}
            >
              取消
            </Button>
            <Button type="submit" variant="solid" disabled={working}>
              {modelId ? '保存' : '添加'}
            </Button>
          </Dialog.Footer>
        </form>
      </Dialog.Content>
    </Dialog>
  );
}
