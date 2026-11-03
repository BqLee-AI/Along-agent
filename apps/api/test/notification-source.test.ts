import { describe, expect, it } from 'bun:test';
import type { PoolClient } from 'pg';
import { noticeCopyFor } from '@along/notifier-core';
import { getTaskNotificationSource } from '../src/modules/tasks/notification-source.js';

function clientFor(row: object): PoolClient {
  return { query: async () => ({ rows: [row] }) } as unknown as PoolClient;
}

describe('notification frozen task source', () => {
  const base = {
    owner_id: 'owner',
    fire_at_utc: new Date('2026-10-17T01:20:37Z'),
    state: 'scheduled',
    state_version: 2,
    schedule_receipt: 'sched:real',
    wall_time: '2026-10-17 01:20:37',
    timezone_id: 'UTC',
    resolved_utc_offset_seconds: 0,
    original_note: '喝水',
  };

  it('passes the frozen elapsed basis and instant through to notification copy', async () => {
    const source = await getTaskNotificationSource(
      clientFor({
        ...base,
        display_version: 'elapsed/1',
        time_basis: {
          kind: 'elapsed',
          anchor_utc: '2026-10-17T01:19:07Z',
          duration_seconds: 90,
          source_message_id: 'source',
          revision: 'elapsed/1',
        },
      }),
      'owner',
      'task',
    );
    expect(source).not.toBeNull();
    const copy = noticeCopyFor(source!);
    expect(copy.title).toBe('提醒 2026-10-17 01:20:37 UTC UTC+00:00');
    expect(copy.body).toContain('UTC 2026-10-17T01:20:37.000Z');
    expect(copy.body).toContain('2026-10-17T01:19:07Z 起经过 90 秒');
  });

  it('keeps legacy copy unchanged and rejects access by a different owner', async () => {
    const client = clientFor({
      ...base,
      wall_time: '2026-10-17 09:20',
      timezone_id: 'Asia/Shanghai',
      display_version: null,
      time_basis: null,
    });
    const source = await getTaskNotificationSource(client, 'owner', 'task');
    expect(noticeCopyFor(source!).title).toBe('提醒 2026-10-17 09:20 Asia/Shanghai');
    expect(await getTaskNotificationSource(client, 'other', 'task')).toBeNull();
  });

  it('does not invent an elapsed basis if frozen data is missing', async () => {
    await expect(
      getTaskNotificationSource(
        clientFor({
          ...base,
          display_version: 'elapsed/1',
          time_basis: null,
        }),
        'owner',
        'task',
      ),
    ).rejects.toThrow('elapsed notification missing frozen time basis');
  });
});
