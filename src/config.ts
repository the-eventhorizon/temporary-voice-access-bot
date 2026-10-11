import "dotenv/config";
import { z } from "zod";

const schema = z.object({
  DISCORD_TOKEN: z.string().min(1),
  DISCORD_APPLICATION_ID: z.string().min(1),
  DISCORD_DEFAULT_GUILD_ID: z.string().optional().default(""),
  DATABASE_PATH: z.string().min(1).default("./data/access-bot.sqlite"),
  INITIAL_JOIN_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(90),
  DEPARTURE_GRACE_PERIOD_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(90),
  REQUEST_EXPIRATION_SECONDS: z.coerce.number().int().positive().default(300),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
});

export const config = schema.parse(process.env);
