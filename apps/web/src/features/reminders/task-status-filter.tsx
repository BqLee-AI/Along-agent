'use client';

import { Button } from '@lorelum/lumen-ui/components/button';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Select } from '@lorelum/lumen-ui/components/select';
import { taskStates, taskStateLabel, type TaskFilter } from './data';

export function TaskStatusFilter({ status }: { status: TaskFilter }) {
  return (
    <form action="/tasks" method="get" className="flex flex-wrap items-end gap-4">
      <div className="grid gap-2">
        <Label htmlFor="task-status">任务状态</Label>
        <Select
          name="status"
          defaultValue={status}
          items={taskStates.map((value) => ({ value, label: taskStateLabel(value) }))}
        >
          <Select.Trigger id="task-status" className="w-full sm:w-56">
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
    </form>
  );
}
