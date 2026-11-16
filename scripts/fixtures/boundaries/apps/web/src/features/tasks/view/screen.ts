import type { Task } from '@/features/tasks/model/task';
import { readTask } from '@/features/tasks/viewmodel/controller';

export type TaskProjection = Pick<Task, 'label'>;
export const showTask = readTask;
