import type { AppType } from "@/server/app";
import type { DashboardFilters, DashboardQuery } from "@/shared/types";
import {
  hc,
  type ClientRequestOptions,
  type ClientResponse,
  type parseResponse,
} from "hono/client";

export const apiClient = hc<AppType>("/");

export function rpcOptions(signal?: AbortSignal): ClientRequestOptions | undefined {
  return signal ? { init: { signal } } : undefined;
}

export function rpcJson<Response extends ClientResponse<unknown>>(
  response: Response | Promise<Response>,
): ReturnType<typeof parseResponse<Response>>;
export async function rpcJson(
  response: ClientResponse<unknown> | Promise<ClientResponse<unknown>>,
): Promise<unknown> {
  const result = await response;
  const payload: unknown = await result.json().catch(() => null);
  if (!result.ok) {
    throw new Error(rpcErrorMessage(payload, result.status));
  }
  return payload;
}

export function toDashboardQuery(filters: DashboardFilters): DashboardQuery {
  const query: DashboardQuery = { from: filters.from, to: filters.to };
  const models = filters.models?.length ? filters.models : filters.model ? [filters.model] : [];
  if (models.length > 0) query.models = models.join(",");
  if (filters.projectId) query.project = filters.projectId;
  if (filters.agentKind && filters.agentKind !== "all") query.agentKind = filters.agentKind;
  return query;
}

function rpcErrorMessage(payload: unknown, statusCode: number): string {
  if (isRecord(payload) && typeof payload["error"] === "string") return payload["error"];
  return `Request failed (${statusCode})`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
