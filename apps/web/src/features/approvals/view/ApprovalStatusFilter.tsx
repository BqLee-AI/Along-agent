'use client';

import { Button } from '@lorelum/lumen-ui/components/button';
import { Label } from '@lorelum/lumen-ui/components/label';
import { Select } from '@lorelum/lumen-ui/components/select';
import { approvalStatusLabels } from '../model/approval';
import type { ApprovalFilter } from '../model/approval';
import { WorkspaceFilterForm } from '@/shell/view/workspace-filter-form';

export function ApprovalStatusFilter({ status }: { status: ApprovalFilter }) {
  return (
    <WorkspaceFilterForm
      action="/approvals"
      className="flex w-full flex-wrap items-end gap-3 sm:w-auto"
    >
      <div className="grid min-w-0 flex-1 gap-2 sm:flex-none">
        <Label htmlFor="approval-status">提议状态</Label>
        <Select
          name="status"
          defaultValue={status}
          items={Object.entries(approvalStatusLabels).map(([value, label]) => ({ value, label }))}
        >
          <Select.Trigger id="approval-status" className="w-full sm:w-48" variant="glass">
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
    </WorkspaceFilterForm>
  );
}
