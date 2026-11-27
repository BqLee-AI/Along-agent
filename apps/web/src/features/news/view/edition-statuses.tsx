import type { Edition } from '../model/news-api';

const coverage: Record<Edition['coverage'], string> = {
  complete: '采集完成',
  partial: '部分覆盖',
  failed: '采集失败',
};
const delivery: Record<Edition['delivery'], string> = {
  pending: '等待投递',
  sending: '正在发送',
  accepted: '微信已受理',
  failed: '投递失败',
  unknown: '投递结果未知',
  skipped: '未投递',
};

export function EditionStatuses({ edition }: { edition: Edition }) {
  return (
    <dl className="flex flex-wrap gap-x-4 gap-y-1 text-sm text-secondary-foreground">
      <div className="flex flex-wrap gap-x-1">
        <dt className="font-medium">采集</dt>
        <dd>{coverage[edition.coverage]}</dd>
      </div>
      <div className="flex flex-wrap gap-x-1">
        <dt className="font-medium">投递</dt>
        <dd>{delivery[edition.delivery]}</dd>
      </div>
    </dl>
  );
}
