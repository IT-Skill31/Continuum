export const MEMORY_KINDS = [
  "preference",
  "request",
  "decision",
  "fact",
  "contact",
] as const;

export type MemoryKind = (typeof MEMORY_KINDS)[number];

export interface Client {
  id: string;
  externalId: string;
  displayName: string | null;
  locale: string;
  createdAt: Date;
}

export interface Conversation {
  id: string;
  clientId: string;
  topic: string | null;
  stage: string;
  status: "open" | "closed" | "escalated";
  lastActiveAt: Date;
}

export interface Memory {
  id: string;
  kind: MemoryKind;
  content: string;
  importance: number;
  createdAt: Date;
}

/** A memory plus the score that caused it to be retrieved. */
export interface RecalledMemory extends Memory {
  score: number;
  matchedBy: Array<"semantic" | "text">;
}

export interface PendingConfirmation {
  id: string;
  description: string;
  createdAt: Date;
}
