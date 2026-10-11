const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;
const configuredLevel = process.env.LOG_LEVEL;
const minimumLevel =
  Object.entries(levels).find(([level]) => level === configuredLevel)?.[1] ??
  levels.info;

export function log(
  level: Level,
  message: string,
  context: Record<string, unknown> = {},
): void {
  if (levels[level] < minimumLevel) return;
  const record = {
    timestamp: new Date().toISOString(),
    level,
    message,
    ...context,
  };
  const output = JSON.stringify(record);
  if (level === "error") console.error(output);
  else if (level === "warn") console.warn(output);
  else console.log(output);
}
