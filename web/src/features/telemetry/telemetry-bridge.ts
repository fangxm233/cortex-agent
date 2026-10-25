import { useEffect } from 'react';
import { useQuery } from '@tanstack/react-query';
import { allowClientKindHeader } from '@/lib/client-kind';
import { isMobileShell, isNativeShell } from '@/lib/desktop-config';
import { safeInvoke } from '@/lib/native-bridge';
import { useTRPC, useTRPCClient } from '@/lib/trpc';
import { telemetryQueue, type ReportSink, type WebTelemetryReport } from './report-queue';

interface TelemetryInfoLike { active: boolean }

/** Take a panic the native shell recorded on an earlier run; forward it only while active. */
export async function forwardNativeCrash(enqueue: (report: WebTelemetryReport) => void, active: boolean): Promise<void> {
  if (!isNativeShell()) return;
  const taken = await safeInvoke('telemetry_take_native_crash');
  if (!taken.ok || !taken.value || !active) return;
  const crash = taken.value;
  enqueue({
    kind: 'native_crash', component: isMobileShell() ? 'android' : 'desktop', at: crash.at,
    message: crash.message.slice(0, 2_000), stack: crash.stack.slice(0, 20_000),
    appVersion: crash.appVersion.slice(0, 40),
  });
}

/** Point the page's queue at this server once it says whether telemetry is active. */
export function applyTelemetryInfo(info: TelemetryInfoLike, sink: ReportSink): void {
  // Only a server that knows `telemetry.info` allow-lists the client header (lib/client-kind).
  allowClientKindHeader();
  if (info.active) telemetryQueue.attach(sink);
  else telemetryQueue.detach();
  void forwardNativeCrash((report) => telemetryQueue.enqueue(report), info.active);
}

type ReportInput = Parameters<ReturnType<typeof useTRPCClient>['telemetry']['report']['mutate']>[0];

export function useTelemetryBridge(): void {
  const trpc = useTRPC();
  const client = useTRPCClient();
  const info = useQuery({ ...trpc.telemetry.info.queryOptions({}), staleTime: 5 * 60_000, retry: 1 });
  useEffect(() => {
    // The inferred router input reads the schema's nullable fields as optional; nulls are valid.
    const sink: ReportSink = (report) => client.telemetry.report.mutate(report as ReportInput);
    if (info.data) applyTelemetryInfo(info.data, sink);
  }, [info.data, client]);
  useEffect(() => {
    // An older server without the endpoint: nothing it would accept, so nothing is held.
    if (info.isError) telemetryQueue.detach();
  }, [info.isError]);
}

/** Mounted once inside the server providers. */
export function TelemetryBridge(): null {
  useTelemetryBridge();
  return null;
}
