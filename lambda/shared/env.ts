/**
 * Reads a required environment variable when the module loads. A missing value
 * fails the Lambda init, which shows up at once as errors and alarms, instead of
 * as an "undefined" table or queue name on the first event.
 */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required environment variable ${name}`);
  return value;
}
