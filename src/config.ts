import "dotenv/config";
import { z } from "zod";

export const configSchema = z
  .object({
    APP_ENV: z.enum(["dev", "local", "prod"]).default("local"),
    DISCORD_TOKEN: z.string().min(1),
    DISCORD_APPLICATION_ID: z.string().min(1),
    DISCORD_DEFAULT_GUILD_ID: z.string().optional().default(""),
    DATABASE_PATH: z.string().min(1).default("./data/access-bot.sqlite"),
    INITIAL_JOIN_TIMEOUT_SECONDS: z.coerce
      .number()
      .int()
      .positive()
      .default(90),
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
  })
  .superRefine((values, context) => {
    if (
      values.WEB_ADMIN_AUTH_SECRET &&
      values.WEB_ADMIN_AUTH_SECRET.length < 32
    ) {
      context.addIssue({
        code: "custom",
        path: ["WEB_ADMIN_AUTH_SECRET"],
        message:
          "WEB_ADMIN_AUTH_SECRET must contain at least 32 characters when configured",
      });
    }
    if (values.APP_ENV === "prod" && !values.WEB_ADMIN_AUTH_SECRET) {
      context.addIssue({
        code: "custom",
        path: ["WEB_ADMIN_AUTH_SECRET"],
        message: "WEB_ADMIN_AUTH_SECRET is required when APP_ENV is prod",
      });
    }
  });

export const config = configSchema.parse(process.env);
