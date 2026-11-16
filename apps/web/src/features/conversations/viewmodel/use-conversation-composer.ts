'use client';

import { useState } from 'react';
import type { ModelSelection } from '@along/contracts';
import type { TaskIntent } from '../model/task';

/** Draft choices belong to the next submission, not to the accepted Run. */
export function useConversationComposer(initialIntent: TaskIntent | null) {
  const [input, setInput] = useState('');
  const [intent, setIntent] = useState<TaskIntent>(initialIntent ?? 'chat');
  const [workspaceId, setWorkspaceId] = useState('');
  const [modelSelection, setModelSelection] = useState<ModelSelection | null>(null);

  return {
    input,
    setInput,
    intent,
    setIntent,
    workspaceId,
    setWorkspaceId,
    modelSelection,
    setModelSelection,
  };
}
