import { Hono } from "hono";
import { hc, type InferRequestType, type InferResponseType } from "hono/client";
import { afterEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type {
  ActivityTimelineQuery,
  ActivityTimelineResponse,
  AgentPageQuery,
  AgentsPageResponse,
  DashboardQuery,
  DashboardResponse,
  SessionQuery,
  SessionSummariesResponse,
  ProjectPageQuery,
  ProjectsPageResponse,
} from "@/shared/types";
import { fetchSessionDetail } from "@/web/lib/api";
import { dismissAllAlerts } from "@/web/lib/product-api";
import { apiClient, rpcJson } from "@/web/lib/rpc-client";

describe("Hono RPC contract", () => {
  it("infers query, path, JSON body and success response types from AppType", () => {
    type RateEndpoint = (typeof apiClient.api.rates)[":model"]["$put"];
    type AgentPageRequest = InferRequestType<typeof apiClient.api.agents.page.$get>;
    type AgentPageResult = InferResponseType<typeof apiClient.api.agents.page.$get, 200>;
    type DashboardRequest = InferRequestType<typeof apiClient.api.dashboard.$get>;
    type DashboardResult = InferResponseType<typeof apiClient.api.dashboard.$get, 200>;
    type SessionRequest = InferRequestType<typeof apiClient.api.sessions.summary.$get>;
    type SessionResult = InferResponseType<typeof apiClient.api.sessions.summary.$get, 200>;
    type TimelineRequest = InferRequestType<typeof apiClient.api.activity.timeline.$get>;
    type TimelineResult = InferResponseType<typeof apiClient.api.activity.timeline.$get, 200>;
    type DeepResult = InferResponseType<typeof apiClient.api.sync.deep.$post, 202>;
    type RateRequest = InferRequestType<RateEndpoint>;
    type ProjectPageRequest = InferRequestType<typeof apiClient.api.projects.page.$get>;
    type ProjectPageResult = InferResponseType<typeof apiClient.api.projects.page.$get, 200>;

    expectTypeOf<DashboardRequest>().toEqualTypeOf<{ query: DashboardQuery }>();
    expectTypeOf<DashboardResult>().toMatchTypeOf<DashboardResponse>();
    expectTypeOf<DashboardResponse>().toMatchTypeOf<DashboardResult>();
    expectTypeOf<AgentPageRequest>().toEqualTypeOf<{ query: AgentPageQuery }>();
    expectTypeOf<AgentPageResult>().toEqualTypeOf<AgentsPageResponse>();
    expectTypeOf<SessionRequest>().toEqualTypeOf<{ query: SessionQuery }>();
    expectTypeOf<SessionResult>().toMatchTypeOf<SessionSummariesResponse>();
    expectTypeOf<SessionSummariesResponse>().toMatchTypeOf<SessionResult>();
    expectTypeOf<TimelineRequest>().toEqualTypeOf<{ query: ActivityTimelineQuery }>();
    expectTypeOf<TimelineResult>().toEqualTypeOf<ActivityTimelineResponse>();
    expectTypeOf<ProjectPageRequest>().toEqualTypeOf<{ query: ProjectPageQuery }>();
    expectTypeOf<ProjectPageResult>().toMatchTypeOf<ProjectsPageResponse>();
    expectTypeOf<ProjectsPageResponse>().toMatchTypeOf<ProjectPageResult>();
    expectTypeOf<DeepResult>().toEqualTypeOf<{ accepted: true }>();
    expectTypeOf<RateRequest["json"]>().toEqualTypeOf<{
      cachedInputRate: number;
      inputRate: number;
      outputRate: number;
    }>();
    expectTypeOf<RateRequest["param"]>().toEqualTypeOf<{ model: string }>();

    const rejectInvalidInput = () => {
      // @ts-expect-error Dashboard query values are serialized strings.
      void apiClient.api.dashboard.$get({ query: { from: 123 } });
      void apiClient.api.rates[":model"].$put({
        // @ts-expect-error Rate input is derived from the server-side Zod schema.
        json: { cachedInputRate: 0, inputRate: "1", outputRate: 2 },
        param: { model: "gpt-test" },
      });
      // @ts-expect-error Dynamic Hono routes require their path params.
      void apiClient.api.sessions[":sessionId"].$get({ query: {} });
      void apiClient.api.agents.page.$get({
        // @ts-expect-error Agent sort is a server-derived literal union.
        query: { sort: "unknown" },
      });
    };
    expectTypeOf(rejectInvalidInput).toBeFunction();
  });

  it("parses successful JSON and preserves a server error message", async () => {
    const app = new Hono()
      .get("/ok", (context) => context.json({ ok: true as const }))
      .get("/error", (context) => context.json({ error: "Specific failure" }, 400));
    const client = hc<typeof app>("http://localhost", { fetch: app.request });

    await expect(rpcJson(client.ok.$get())).resolves.toEqual({ ok: true });
    await expect(rpcJson(client.error.$get())).rejects.toThrow("Specific failure");
  });
});

describe("RPC browser transport", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("forwards AbortSignal and encodes dynamic path and query values", async () => {
    const requests: { init?: RequestInit; input: string }[] = [];
    const mockedFetch = (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      requests.push({ ...(init ? { init } : {}), input: url });
      return Promise.resolve(
        new Response(JSON.stringify({ sessionId: "session/with spaces?#" }), {
          headers: { "content-type": "application/json" },
          status: 200,
        }),
      );
    };
    vi.stubGlobal("fetch", mockedFetch);
    const controller = new AbortController();

    await fetchSessionDetail(
      "session/with spaces?#",
      {
        from: "2026-07-01",
        models: ["gpt/a", "gpt b"],
        projectId: "project/alpha",
        to: "2026-07-12",
      },
      controller.signal,
    );

    const request = requests[0];
    expect(request?.input).toContain(
      "/api/sessions/session%2Fwith%20spaces%3F%23?from=2026-07-01&to=2026-07-12",
    );
    expect(request?.input).toContain("models=gpt%2Fa%2Cgpt+b");
    expect(request?.input).toContain("project=project%2Falpha");
    expect(request?.init?.signal).toBe(controller.signal);
  });

  it("falls back to bounded alert patches while an older server lacks bulk dismiss", async () => {
    const requests: { method: string; pathname: string }[] = [];
    vi.stubGlobal("fetch", (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(
        typeof input === "string" ? input : input instanceof URL ? input.href : input.url,
        "http://localhost",
      );
      const method = init?.method ?? "GET";
      requests.push({ method, pathname: url.pathname });
      if (method === "DELETE") {
        return Promise.resolve(
          new Response(JSON.stringify({ error: "API route not found" }), {
            headers: { "content-type": "application/json" },
            status: 404,
          }),
        );
      }
      return Promise.resolve(
        new Response(
          JSON.stringify({
            alert: {
              dismissedAt: "2026-07-16T09:00:00.000Z",
              id: url.pathname.split("/").at(-1),
            },
          }),
          { headers: { "content-type": "application/json" }, status: 200 },
        ),
      );
    });

    await expect(dismissAllAlerts(["alert/one", "alert two"])).resolves.toEqual({
      dismissedCount: 2,
    });
    expect(requests).toEqual([
      { method: "DELETE", pathname: "/api/alerts" },
      { method: "PATCH", pathname: "/api/alerts/alert%2Fone" },
      { method: "PATCH", pathname: "/api/alerts/alert%20two" },
    ]);
  });
});
