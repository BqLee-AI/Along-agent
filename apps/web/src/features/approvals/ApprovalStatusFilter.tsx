'use client';

import { Button } from '@lorelum/lumen-ui/components/button';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Select } from '@lorelum/lumen-ui/components/select';
import { approvalStatusLabels, type ApprovalFilter } from './model';

export function ApprovalStatusFilter({ status }: { status: ApprovalFilter }) {
  return (
    <form className="flex flex-wrap items-end gap-3" method="GET">
      <div className="grid gap-2">
        <Label htmlFor="approval-status">提议状态</Label>
        <Select
          name="status"
          defaultValue={status}
          items={Object.entries(approvalStatusLabels).map(([value, label]) => ({ value, label }))}
        >
          <Select.Trigger id="approval-status">
            <Select.Value />
          </Select.Trigger>
          <Select.Content>
            {Object.entries(approvalStatusLabels).map(([value, label]) => (
              <Select.Item key={value} value={value}>
                {label}
              </Select.Item>
            ))}
          </Select.Content>
        </Select>
      </div>
      <Button variant="glass" color="default" type="submit">
        查看此状态
      </Button>
    </form>
  );
}
