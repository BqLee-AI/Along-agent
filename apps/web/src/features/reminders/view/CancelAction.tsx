'use client';

import { useState } from 'react';
import { Button } from '@lorelum/lumen-ui/components/button';
import { Alert } from '@lorelum/lumen-ui/components/alert';
import type { ApiResult } from '@/shared/http/result';
import type { Me } from '@/shared/session/identity';
import { cancellationAllowed, taskStateLabel } from '../model/data';
import { ResourceError } from './resource-ui';
import { useCancelReminder } from '../viewmodel/use-cancel-reminder';

export default function CancelAction({
  taskId,
  state: initialState,
  meResult,
}: {
  taskId: string;
  state: string;
  meResult: ApiResult<Me>;
}) {
  const controller = useCancelReminder(taskId, initialState, meResult);
  const [confirming, setConfirming] = useState(false);
  const returnTo = `/tasks/${encodeURIComponent(taskId)}`;
  return (
    <section
      className="min-w-0 space-y-5 [overflow-wrap:anywhere]"
      aria-labelledby="cancel-heading"
      aria-busy={Boolean(controller.busy)}
    >
      <div>
        <h2 id="cancel-heading" className="text-base font-semibold">
          取消这条提醒
        </h2>
        <p className="mt-2 text-sm leading-[22px] text-muted-foreground">
          只取消此提醒；已经发生的通知不会撤回。提交取消不等于调度器已经确认取消。
        </p>
      </div>
      <p role="status" className="text-sm leading-[22px]">
        最近获取的状态：{taskStateLabel(controller.state)}
      </p>
      {!controller.identity.ok ? (
        <ResourceError error={controller.identity} returnTo={returnTo}>
          <Button
            variant="glass"
            color="default"
            disabled={Boolean(controller.busy)}
            onClick={() => void controller.recover('identity')}
          >
            重新读取身份
          </Button>
        </ResourceError>
      ) : !controller.identity.data.csrf_token ? (
        <div className="space-y-2">
          <p className="text-sm text-muted-foreground">
            当前身份没有可用的 CSRF 凭据，取消不可用。
          </p>
          <Button
            variant="glass"
            color="default"
            disabled={Boolean(controller.busy)}
            onClick={() => void controller.recover('identity')}
          >
            重新读取身份
          </Button>
        </div>
      ) : null}
      {controller.uncertain ? (
        <Alert variant="glass">
          <Alert.Content>
            <Alert.Title>取消结果待确认</Alert.Title>
            <Alert.Description>
              请求可能已经被接受。请先读取此任务状态；不会自动补发取消。若读取后仍可取消，明确再次提交将沿用原幂等键。
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {controller.accepted && ['cancelled', 'cancel_pending'].includes(controller.state) ? (
        <Alert variant="glass">
          <Alert.Content>
            <Alert.Title>
              {controller.state === 'cancelled' ? '已取得取消完成回执' : '取消请求已接受'}
            </Alert.Title>
            <Alert.Description>
              {controller.state === 'cancelled'
                ? '服务端已记录取消完成；既有通知记录仍然保留。'
                : '当前为 cancel_pending，仍在等待调度器取消回执；不能视作已取消。'}
            </Alert.Description>
          </Alert.Content>
        </Alert>
      ) : null}
      {!cancellationAllowed(controller.state) ? (
        <p className="text-sm text-muted-foreground">
          {controller.state === 'cancel_pending'
            ? '已提交取消，等待回执期间不能重复取消。可只读更新状态。'
            : '当前状态不开放取消。已触发、错过或已取消的提醒保持只读。'}
        </p>
      ) : null}
      {controller.error ? <ResourceError error={controller.error} returnTo={returnTo} /> : null}
      {confirming && controller.canCancel ? (
        <div className="space-y-4">
          <p>确定取消这条冻结时间为当前详情所示的提醒？</p>
          <div className="flex flex-wrap gap-4">
            <Button variant="glass" color="default" onClick={() => setConfirming(false)}>
              保留提醒
            </Button>
            <Button
              color="danger"
              disabled={!controller.canCancel}
              onClick={() => {
                setConfirming(false);
                void controller.cancel();
              }}
            >
              确认取消此提醒
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap gap-4">
          <Button
            variant="glass"
            color="default"
            disabled={!controller.canCancel}
            onClick={() => setConfirming(true)}
          >
            {controller.busy === 'cancel' ? '正在提交取消…' : '取消这条提醒'}
          </Button>
          <Button
            variant="clear"
            color="default"
            disabled={Boolean(controller.busy)}
            onClick={() => void controller.recover()}
          >
            {controller.busy === 'read' ? '正在读取…' : '读取取消状态'}
          </Button>
        </div>
      )}
    </section>
  );
}
