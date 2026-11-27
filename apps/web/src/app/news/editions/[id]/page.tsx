import { notFound } from 'next/navigation';
import { z } from 'zod';
import { EditionScreen } from '@/features/news/view/edition-screen';

export default async function EditionPage({ params }: { params: Promise<{ id: string }> }) {
  const result = z.string().uuid().safeParse((await params).id);
  if (!result.success) notFound();
  const id = result.data.toLowerCase();
  return <EditionScreen key={id} id={id} />;
}
