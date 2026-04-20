import type { AlterEventTrigger } from "./event-trigger.alter.ts";
import type { CommentEventTrigger } from "./event-trigger.comment.ts";
import type { CreateEventTrigger } from "./event-trigger.create.ts";
import type { DropEventTrigger } from "./event-trigger.drop.ts";
import type { SecurityLabelEventTrigger } from "./event-trigger.security-label.ts";

export type EventTriggerChange =
  | AlterEventTrigger
  | CommentEventTrigger
  | CreateEventTrigger
  | DropEventTrigger
  | SecurityLabelEventTrigger;
