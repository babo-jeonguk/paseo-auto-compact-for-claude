import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";

export const SettingsSchema = z.object({
  enabled: z.boolean().default(true),
  threshold: z.number().int().min(1).max(10_000_000).default(200_000),
  idleMinutes: z.number().int().min(1).max(1_440).default(55),
  disabledProviders: z.array(z.string().min(1)).default([]),
});
export type Settings = z.output<typeof SettingsSchema>;
export const DEFAULT_SETTINGS = SettingsSchema.parse({});
export const compactSettings = defineSettings({
  id: "automation",
  scope: "host",
  version: 1,
  schema: SettingsSchema,
});
