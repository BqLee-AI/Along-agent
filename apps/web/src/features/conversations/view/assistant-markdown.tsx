'use client';

import { memo } from 'react';
import { Markdown } from '@lorelum/lumen-ui/components/markdown';
import { Table } from '@lorelum/lumen-ui/components/table';

/** The same safe Markdown renderer is used for persisted and incremental text. */
export const AssistantMarkdown = memo(function AssistantMarkdown({
  text,
  streaming = false,
}: {
  text: string;
  streaming?: boolean;
}) {
  return (
    <Markdown
      className="min-w-0"
      data-testid="assistant-markdown"
      streaming={streaming}
      components={{
        a: ({ children, href }) => (
          <a href={href} target="_blank" rel="noopener noreferrer">
            {children}
          </a>
        ),
        // Keep remote image URLs readable without fetching untrusted tracking pixels.
        img: ({ alt, src }) => (
          <a
            href={typeof src === 'string' ? src : undefined}
            target="_blank"
            rel="noopener noreferrer"
          >
            {alt || '查看图片'}
          </a>
        ),
        table: ({ children }) => (
          <div className="max-w-full overflow-x-auto" tabIndex={0} role="region" aria-label="表格">
            <Table variant="plain">{children}</Table>
          </div>
        ),
      }}
    >
      {text}
    </Markdown>
  );
});
