import React from 'react';
import { Box, Text } from 'ink';
import type { TabData } from '../hooks/useDashboardData.js';

interface DashboardCostTabProps {
  data: TabData;
}

export function DashboardCostTab({ data }: DashboardCostTabProps): React.JSX.Element {
  if (data.loading && data.data.length === 0) {
    return <Text dimColor>Loading cost summary...</Text>;
  }
  if (data.error) {
    return <Text color="red">Error: {data.error}</Text>;
  }
  if (!data.data || (Array.isArray(data.data) && data.data.length === 0)) {
    return <Text dimColor>No cost data</Text>;
  }

  // The server returns a CostSummary object (domain/costs/cost-tracker.ts): top-level
  // today/week/month/total are USD numbers; byMode maps mode → { today, week, month, total }.
  // useDashboardData wraps a non-array response in a single-element array.
  const costData: any = Array.isArray(data.data) ? data.data[0] : data.data;

  const usd = (v: unknown): string => `$${typeof v === 'number' ? v.toFixed(4) : String(v)}`;
  // byMode is keyed by PERIOD (today/week/month/total); each value is a ModeBuckets
  // { total, api, plan, ... } breaking that period down by cost type. The all-time
  // bucket (byMode.total) gives the api/plan split; skip the 'total' meta key.
  const allTime: Record<string, any> = costData?.byMode?.total && typeof costData.byMode.total === 'object' ? costData.byMode.total : {};
  const modeEntries = Object.entries(allTime)
    .filter(([k, v]: [string, any]) => k !== 'total' && typeof v === 'number' && v > 0);
  const hasAnyTotal = costData?.total != null || costData?.month != null || costData?.today != null;

  if (!hasAnyTotal && modeEntries.length === 0) {
    return <Text dimColor>No cost summary available</Text>;
  }

  return (
    <Box flexDirection="column">
      <Box marginBottom={1}>
        <Text bold>Cost Summary</Text>
      </Box>

      {costData?.total != null ? (
        <Box><Text>Total:      </Text><Text>{usd(costData.total)}</Text></Box>
      ) : null}
      {costData?.month != null ? (
        <Box><Text>This month: </Text><Text>{usd(costData.month)}</Text></Box>
      ) : null}
      {costData?.week != null ? (
        <Box><Text>This week:  </Text><Text>{usd(costData.week)}</Text></Box>
      ) : null}
      {costData?.today != null ? (
        <Box><Text>Today:      </Text><Text>{usd(costData.today)}</Text></Box>
      ) : null}

      {/* All-time cost-type breakdown (api vs plan), strongest first */}
      {modeEntries.length > 0 ? (
        <Box flexDirection="column" marginTop={1}>
          <Text dimColor>By cost type (all-time):</Text>
          {modeEntries
            .sort(([, a]: [string, any], [, b]: [string, any]) => (b as number) - (a as number))
            .map(([mode, v]: [string, any]) => (
              <Box key={mode} marginLeft={1}>
                <Text dimColor>{mode}: </Text>
                <Text>{usd(v)}</Text>
              </Box>
            ))}
        </Box>
      ) : null}
    </Box>
  );
}
