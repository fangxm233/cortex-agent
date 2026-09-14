import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

/** Format `now` in the given IANA timezone. Throws RangeError if the timezone is invalid. */
function describeTime(now: Date, timezone: string): {
  timezone: string;
  local: string;
  offset: string;
  weekday: string;
} {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
    weekday: 'short',
    timeZoneName: 'shortOffset',
  }).formatToParts(now);

  const get = (type: string): string => parts.find((p) => p.type === type)?.value ?? '';
  const date = `${get('year')}-${get('month')}-${get('day')}`;
  // en-CA renders 24h hour as "24" at midnight; normalize to "00".
  const hour = get('hour') === '24' ? '00' : get('hour');
  const time = `${hour}:${get('minute')}:${get('second')}`;
  const offset = get('timeZoneName').replace(/^GMT/, 'UTC');

  return {
    timezone,
    local: `${date} ${time}`,
    offset,
    weekday: get('weekday'),
  };
}

export function registerTimeTools(server: McpServer): void {
  server.tool(
    'current_time',
    'Get the current date and time. Optionally specify an IANA timezone (e.g. "Asia/Shanghai", "America/New_York", "UTC"); defaults to the server local timezone. Returns the Unix epoch, UTC ISO string, and the localized wall-clock time with UTC offset.',
    {
      timezone: z
        .string()
        .optional()
        .describe('IANA timezone name, e.g. "Asia/Shanghai", "Europe/London", "UTC". Defaults to the server local timezone.'),
    },
    { readOnlyHint: true },
    async ({ timezone }: { timezone?: string }) => {
      const now = new Date();
      const tz = timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
      try {
        const d = describeTime(now, tz);
        const result = {
          timezone: d.timezone,
          local: d.local,
          weekday: d.weekday,
          offset: d.offset,
          iso_utc: now.toISOString(),
          unix_ms: now.getTime(),
        };
        return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
      } catch (e) {
        return {
          content: [
            {
              type: 'text',
              text: `Invalid timezone "${tz}": ${(e as Error).message}. Use an IANA name like "Asia/Shanghai" or "UTC".`,
            },
          ],
          isError: true,
        };
      }
    },
  );
}
