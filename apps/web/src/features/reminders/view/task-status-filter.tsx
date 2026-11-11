'use client';

import { Button } from '@lorelum/lumen-ui/components/button';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Select } from '@lorelum/lumen-ui/components/select';
import { taskStates, taskStateLabel } from '../model/data';
import type { TaskFilter } from '../model/data';
import { WorkspaceFilterForm } from '@/shell/view/workspace-filter-form';

export function TaskStatusFilter({ status }: { status: TaskFilter }) {
  return (
    <WorkspaceFilterForm
      action="/tasks"
      className="flex w-full flex-wrap items-end gap-3 sm:w-auto"
    >
      <div className="grid min-w-0 flex-1 gap-2 sm:flex-none">
        <Label htmlFor="task-status">任务状态</Label>
        <Select
          name="status"
          defaultValue={status}
          items={taskStates.map((value) => ({ value, label: taskStateLabel(value) }))}
        >
          <Select.Trigger id="task-status" className="w-full sm:w-56" variant="glass">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {taskStates.map((value) => (
              <Select.Item key={value} value={value}>
                {taskStateLabel(value)}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <Button variant="glass" color="default" type="submit">
        应用筛选
      </Button>
    </WorkspaceFilterForm>
  );
}
