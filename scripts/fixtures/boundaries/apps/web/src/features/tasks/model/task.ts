import { request } from '@/shared/http/client';

export type Task = { label: string };

export function loadTask(): Task {
  return { label: request() };
}
