import { STAGE_LABELS } from "../../domain/deal";
import type { Operation } from "./service";
import type { CommandActivity } from "./activity";

export const RESULT_LABELS = {
  queued: "Queued",
  saving: "Saving",
  succeeded: "Saved",
  failed: "Failed",
  conflicted: "Conflict",
  unconfirmed: "Unconfirmed",
  skipped: "No change needed",
};

export function operationLabel(item: Operation): string {
  return item.status === "saving" || item.status === "queued"
    ? `${item.kind === "undo" ? "Undoing" : "Moving to"} ${STAGE_LABELS[item.command.stage]}`
    : RESULT_LABELS[item.status];
}

export function activityLabel(item: CommandActivity): string {
  if (item.resolution === "kept") return "Latest kept";
  if (item.resolution === "replaced") return "Reviewed";
  return item.status === "queued" || item.status === "saving"
    ? `${item.kind === "undo" ? "Undoing" : "Moving to"} ${STAGE_LABELS[item.stage]}`
    : RESULT_LABELS[item.status];
}
