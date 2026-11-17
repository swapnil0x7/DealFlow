export const STAGES = [
  "new-lead",
  "contacted",
  "demo-done",
  "proposal-sent",
  "negotiation",
  "won",
  "lost",
] as const;

export type Stage = (typeof STAGES)[number];

export const STAGE_LABELS: Record<Stage, string> = {
  "new-lead": "New Lead",
  contacted: "Contacted",
  "demo-done": "Demo Done",
  "proposal-sent": "Proposal Sent",
  negotiation: "Negotiation",
  won: "Won",
  lost: "Lost",
};

export interface Deal {
  readonly id: string;
  readonly companyName: string;
  readonly valuePaise: number;
  readonly ownerId: string;
  readonly stage: Stage;
  readonly createdAt: string;
  readonly lastActivityAt: string | null;
  readonly updatedAt: string;
  readonly version: number;
}

export interface Owner {
  readonly id: string;
  readonly name: string;
}

export const isStage = (value: unknown): value is Stage =>
  typeof value === "string" && STAGES.some((stage) => stage === value);
