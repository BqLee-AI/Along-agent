export interface Actor {
  ownerId: string;
  sessionId: string | null;
  displayName: string;
  timezoneId: string | null;
}
