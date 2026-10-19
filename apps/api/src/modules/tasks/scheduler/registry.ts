// Scheduler registry: local schedule-receipt issuance + revoke checks.
// Production registry: the schedule receipt is issued by the same transaction
// that flips the task to scheduled; revoke checks consult the local registry
// of撤销回执 (cancel receipts recorded by the cancel phase / provider).
// Registration is in-memory per worker process; receipts persisted on tasks
// are the durable record, the registry only gates the two-step cancel.
const receipts = new Map<string, string>();
const revoked = new Set<string>();

export function receiptKey(taskId: string): string {
  return `sched:${taskId}`;
}

export function issueScheduleReceipt(taskId: string): string {
  const receipt = receiptKey(taskId);
  receipts.set(taskId, receipt);
  return receipt;
}

export function readScheduleReceipt(taskId: string): string | null {
  return receipts.get(taskId) ?? null;
}

export function recordCancelReceipt(taskId: string): string {
  const receipt = `cancel:${taskId}`;
  revoked.add(taskId);
  return receipt;
}

export function hasCancelReceipt(taskId: string): boolean {
  return revoked.has(taskId);
}

export function clearRegistry(): void {
  receipts.clear();
  revoked.clear();
}
