import type { ReportPreviewResponse, ReportRequest } from "@/shared/types";
import { apiClient, rpcJson, rpcOptions } from "@/web/lib/rpc-client";

export function fetchReportPreview(
  request: ReportRequest,
  signal?: AbortSignal,
): Promise<ReportPreviewResponse> {
  return rpcJson(apiClient.api.reports.preview.$post({ json: request }, rpcOptions(signal)));
}

export async function fetchReportExport(
  request: ReportRequest,
): Promise<{ blob: Blob; filename: string }> {
  const response = await apiClient.api.reports.export.$post({ json: request });
  if (!response.ok) {
    await rpcJson(response);
    throw new Error(`Request failed (${response.status})`);
  }
  return {
    blob: await response.blob(),
    filename: `codex-usage-${request.preset}.${request.format}`,
  };
}
