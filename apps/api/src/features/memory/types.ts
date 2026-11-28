import type { PoolClient } from 'pg';

export type SourcePurpose = 'explicit' | 'compact' | 'read' | 'correction';
export interface MemorySources {
  // Must authorize and, for writes, serialize source/qualification changes through commit.
  validate(
    client: PoolClient,
    input: {
      ownerId: string;
      conversationId: string;
      messageIds: string[];
      purpose: SourcePurpose;
      summaryId?: string;
    },
  ): Promise<void>;
}

export type MemoryCategory = 'project' | 'preference' | 'goal';

export interface MemoryRecord {
  id: string;
  ownerId: string;
  conversationId: string | null;
  messageIds: string[];
  content: string;
  sourceKind: 'explicit' | 'compact' | 'manual';
  category: MemoryCategory | null;
  summaryId: string | null;
  revision: number;
  status: 'active' | 'stopped';
  expiresAt: string | null;
  createdAt: string;
  updatedAt: string;
}
