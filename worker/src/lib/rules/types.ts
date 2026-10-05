import { z } from "zod";

const textValue = z.string().min(1).max(500);

export const RuleConditionSchema = z.discriminatedUnion("field", [
  z.object({
    field: z.literal("from_address"),
    operator: z.enum(["equals", "contains", "ends_with"]),
    value: textValue,
  }),
  z.object({
    field: z.literal("from_domain"),
    operator: z.literal("equals"),
    value: textValue,
  }),
  z.object({
    field: z.literal("subject"),
    operator: z.enum(["contains", "equals", "starts_with"]),
    value: textValue,
  }),
  z.object({
    field: z.literal("body"),
    operator: z.literal("contains"),
    value: textValue,
  }),
  z.object({
    field: z.literal("has_attachments"),
    operator: z.literal("is"),
    value: z.boolean(),
  }),
  z.object({
    field: z.literal("spam_score"),
    operator: z.enum(["gte", "lte"]),
    value: z.number().finite(),
  }),
  z.object({
    // The inbox's learning filter's score (0–1); null (no score) never matches.
    field: z.literal("spam_probability"),
    operator: z.enum(["gte", "lte"]),
    value: z.number().min(0).max(1),
  }),
  z.object({
    field: z.literal("header"),
    name: textValue,
    operator: z.enum(["equals", "contains"]),
    value: textValue,
  }),
]);

export const RuleConditionsSchema = z.array(RuleConditionSchema).max(10);

/** What the sending server is told when a `reject` rule gives no reason. */
export const DEFAULT_REJECT_REASON = "Rejected by mailbox policy";

export const RuleActionSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("archive") }),
  z.object({ type: z.literal("mark_spam") }),
  z.object({
    type: z.literal("move_to_folder"),
    mailboxId: textValue,
  }),
  z.object({
    type: z.literal("snooze"),
    hours: z.number().int().min(1).max(720),
  }),
  z.object({
    type: z.literal("assign"),
    userId: textValue,
  }),
  z.object({
    type: z.literal("auto_reply"),
    subject: z.string().min(1).max(200).optional(),
    bodyText: z.string().min(1).max(5000),
  }),
  z.object({
    // A model files the message into the inbox's described folders, later
    // (a queue job): the handler never waits on it.
    type: z.literal("ai_file"),
    archiveWhenFiled: z.boolean().optional(),
  }),
  z.object({
    // Refuses the message at SMTP time, before anything is stored.
    type: z.literal("reject"),
    // It travels in the SMTP reply: printable ASCII on one line.
    reason: z
      .string()
      .trim()
      .min(1)
      .max(200)
      .regex(/^[\x20-\x7E]+$/, "Use printable ASCII characters only")
      .optional(),
  }),
]);

export const RuleActionsSchema = z.array(RuleActionSchema).min(1).max(5);

export type RuleCondition = z.infer<typeof RuleConditionSchema>;
export type RuleAction = z.infer<typeof RuleActionSchema>;
