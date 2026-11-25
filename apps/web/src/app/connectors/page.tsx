import { FeishuConnectionScreen } from '@/features/capabilities/view/feishu-connection-screen';
import type { PageQuery } from '@/shared/session/navigation';

export default async function ConnectorsPage({
  searchParams,
}: {
  searchParams: Promise<PageQuery>;
}) {
  const { app } = await searchParams;
  return <FeishuConnectionScreen showConnection={app === 'feishu'} />;
}
