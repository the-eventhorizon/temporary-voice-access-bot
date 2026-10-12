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
  WEB_ADMIN_HOST: z.string().default("127.0.0.1"),
  WEB_ADMIN_PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  WEB_ADMIN_AUTH_HEADER: z
    .string()
    .regex(/^[A-Za-z0-9-]+$/)
    .default("X-Website-Admin"),
  WEB_ADMIN_AUTH_SECRET: z.string().default(""),
});

export const config = schema
  .refine(
    (values) =>
      !values.WEB_ADMIN_AUTH_SECRET ||
      values.WEB_ADMIN_AUTH_SECRET.length >= 32,
    {
      message:
        "WEB_ADMIN_AUTH_SECRET must contain at least 32 characters when web admin is enabled",
    },
  )
  .parse(process.env);
