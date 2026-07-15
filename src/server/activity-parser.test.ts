import { describe, expect, it } from "vitest";

import {
  ACTIVITY_CATEGORIES,
  ACTIVITY_TOOLS,
  createActivityParser,
  hashActivityDedupeInput,
  normalizeActivityTool,
  parseActivityLine,
  parseActivityRecord,
} from "@/server/activity-parser";

const SESSION_ID = "session-activity";

describe("activity parser", () => {
  it("tracks only the first session metadata record in a physical JSONL stream", () => {
    const parser = createActivityParser();

    expect(
      parser.parseLine(
        line("session_meta", "2026-07-12T01:00:00.000Z", {
          id: "agent-activity",
          session_id: SESSION_ID,
        }),
      ),
    ).toBeNull();
    expect(parser.sessionId).toBe(SESSION_ID);

    parser.parseLine(
      line("session_meta", "2026-07-12T01:00:00.001Z", {
        id: "inherited-parent",
        session_id: "different-session",
      }),
    );
    const event = parser.parseLine(
      line("event_msg", "2026-07-12T01:00:01.000Z", {
        collaboration_mode_kind: "default",
        started_at: "2026-07-12T01:00:00.999Z",
        turn_id: "turn-1",
        type: "task_started",
      }),
    );

    expect(parser.sessionId).toBe(SESSION_ID);
    expect(event).toMatchObject({
      category: "task_start",
      sessionId: SESSION_ID,
      timestamp: "2026-07-12T01:00:01.000Z",
      tool: "other",
    });
    expect(event?.eventHash).toMatch(/^[a-f\d]{64}$/u);
  });

  it.each([
    ["turn context", record("turn_context", { turn_id: "turn-1" }), "turn", "other"],
    [
      "patch completion",
      record("event_msg", { call_id: "call-patch", type: "patch_apply_end" }),
      "patch",
      "patch",
    ],
    [
      "shell call",
      record("response_item", {
        arguments: '{"cmd":"private command"}',
        call_id: "call-shell",
        name: "exec_command",
        type: "function_call",
      }),
      "shell",
      "shell",
    ],
    [
      "MCP completion",
      record("event_msg", {
        call_id: "call-mcp",
        invocation: { arguments: { secret: true }, server: "files", tool: "read" },
        result: { private: "tool output" },
        type: "mcp_tool_call_end",
      }),
      "mcp",
      "mcp",
    ],
    [
      "legacy MCP call",
      record("response_item", {
        call_id: "call-mcp-legacy",
        name: "mcp__github__search_code",
        type: "function_call",
      }),
      "mcp",
      "mcp",
    ],
    [
      "web completion",
      record("event_msg", {
        call_id: "ws-1",
        query: "private query",
        type: "web_search_end",
      }),
      "web",
      "web",
    ],
    [
      "legacy web call",
      record("response_item", {
        call_id: "call-web-legacy",
        name: "web__run",
        type: "function_call",
      }),
      "web",
      "web",
    ],
    ["compaction", record("compacted", { private: "replacement history" }), "compaction", "other"],
    [
      "abort",
      record("event_msg", { reason: "private reason", turn_id: "turn-2", type: "turn_aborted" }),
      "abort",
      "other",
    ],
    [
      "task completion",
      record("event_msg", {
        last_agent_message: "private answer",
        turn_id: "turn-3",
        type: "task_complete",
      }),
      "task_complete",
      "other",
    ],
  ] as const)("classifies an explicit %s marker", (_label, value, category, tool) => {
    expect(parseActivityRecord(value, SESSION_ID)).toMatchObject({ category, tool });
  });

  it("uses safe correlation metadata so paired records share a stable hash", () => {
    const patchCall = parseActivityRecord(
      record("response_item", {
        call_id: "call-patch",
        input: "private patch",
        name: "apply_patch",
        type: "custom_tool_call",
      }),
      SESSION_ID,
    );
    const patchEnd = parseActivityRecord(
      record(
        "event_msg",
        { call_id: "call-patch", changes: { private: true }, type: "patch_apply_end" },
        { timestamp: "2026-07-12T01:00:00.083Z" },
      ),
      SESSION_ID,
    );
    const webEnd = parseActivityRecord(
      record("event_msg", { call_id: "ws-1", query: "private query", type: "web_search_end" }),
      SESSION_ID,
    );
    const webCall = parseActivityRecord(
      record(
        "response_item",
        { id: "ws-1", status: "completed", type: "web_search_call" },
        { timestamp: "2026-07-12T01:00:00.010Z" },
      ),
      SESSION_ID,
    );

    expect(patchCall?.dedupeInput).toBe(patchEnd?.dedupeInput);
    expect(patchCall?.eventHash).toBe(patchEnd?.eventHash);
    expect(webEnd?.eventHash).toBe(webCall?.eventHash);
    expect(hashActivityDedupeInput(patchCall?.dedupeInput ?? "")).toBe(patchCall?.eventHash);

    const serialized = JSON.stringify([patchCall, patchEnd, webEnd, webCall]);
    expect(serialized).not.toContain("private");
    expect(serialized).not.toContain("arguments");
    expect(serialized).not.toContain("output");
  });

  it("keeps the persisted identity stable when tool classification changes", () => {
    const shellClassification = parseActivityRecord(
      record("response_item", {
        call_id: "call-stable",
        name: "exec_command",
        type: "function_call",
      }),
      SESSION_ID,
    );
    const mcpClassification = parseActivityRecord(
      record("response_item", {
        call_id: "call-stable",
        name: "mcp__files__read",
        type: "function_call",
      }),
      SESSION_ID,
    );

    expect(shellClassification).toMatchObject({ category: "shell", tool: "shell" });
    expect(mcpClassification).toMatchObject({ category: "mcp", tool: "mcp" });
    expect(shellClassification?.eventHash).toBe(mcpClassification?.eventHash);
    expect(shellClassification?.legacyEventHash).not.toBe(mcpClassification?.legacyEventHash);
  });

  it("coalesces the paired compaction snapshot and event marker within one second", () => {
    const snapshot = parseActivityRecord(
      record("compacted", { replacement_history: "private" }),
      SESSION_ID,
    );
    const marker = parseActivityRecord(
      record("event_msg", { type: "context_compacted" }, { timestamp: "2026-07-12T01:00:00.028Z" }),
      SESSION_ID,
    );

    expect(snapshot?.eventHash).toBe(marker?.eventHash);
  });

  it("normalizes explicit tool names without inspecting arguments", () => {
    expect(ACTIVITY_CATEGORIES).toHaveLength(11);
    expect(ACTIVITY_TOOLS).toEqual(["shell", "patch", "file", "web", "mcp", "other"]);
    expect(normalizeActivityTool("exec_command")).toBe("shell");
    expect(normalizeActivityTool("apply_patch")).toBe("patch");
    expect(normalizeActivityTool("view_image")).toBe("file");
    expect(normalizeActivityTool("web__run")).toBe("web");
    expect(normalizeActivityTool("mcp__github__search_code")).toBe("mcp");
    expect(normalizeActivityTool("exec")).toBe("other");
    expect(normalizeActivityTool(null)).toBe("other");
  });

  it("fails closed for malformed, private-content, generic, and output records", () => {
    expect(parseActivityLine("not-json", SESSION_ID)).toBeNull();
    expect(parseActivityLine("[]", SESSION_ID)).toBeNull();
    expect(
      parseActivityRecord(record("response_item", { role: "user", type: "message" }), null),
    ).toBeNull();
    expect(
      parseActivityRecord(
        record("event_msg", { message: "please run apply_patch", type: "user_message" }),
        SESSION_ID,
      ),
    ).toBeNull();
    expect(
      parseActivityRecord(
        record("response_item", { input: "private", name: "exec", type: "custom_tool_call" }),
        SESSION_ID,
      ),
    ).toMatchObject({ category: "other", tool: "other" });
    expect(
      parseActivityRecord(
        record("response_item", {
          call_id: "call-1",
          output: "private",
          type: "function_call_output",
        }),
        SESSION_ID,
      ),
    ).toBeNull();
    expect(
      parseActivityRecord(
        record("event_msg", { turn_id: "turn-1", type: "task_started" }, { timestamp: "invalid" }),
        SESSION_ID,
      ),
    ).toBeNull();
  });

  it("falls back to explicit lifecycle timestamps and keeps sessions isolated", () => {
    const start = {
      payload: {
        started_at: "2026-07-12T01:00:00.000Z",
        turn_id: "turn-1",
        type: "task_started",
      },
      type: "event_msg",
    };
    const complete = {
      payload: {
        completed_at: "2026-07-12T01:01:00.000Z",
        turn_id: "turn-1",
        type: "task_complete",
      },
      type: "event_msg",
    };
    const abort = {
      payload: {
        completed_at: "2026-07-12T01:02:00.000Z",
        turn_id: "turn-2",
        type: "turn_aborted",
      },
      type: "event_msg",
    };
    const first = parseActivityRecord(start, "session-a");
    const second = parseActivityRecord(start, "session-b");

    expect(first?.timestamp).toBe("2026-07-12T01:00:00.000Z");
    expect(parseActivityRecord(complete, SESSION_ID)?.timestamp).toBe("2026-07-12T01:01:00.000Z");
    expect(parseActivityRecord(abort, SESSION_ID)?.timestamp).toBe("2026-07-12T01:02:00.000Z");
    expect(first?.eventHash).not.toBe(second?.eventHash);
  });
});

function record(
  type: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    payload,
    timestamp: "2026-07-12T01:00:00.000Z",
    type,
    ...overrides,
  };
}

function line(type: string, timestamp: string, payload: Record<string, unknown>): string {
  return JSON.stringify({ payload, timestamp, type });
}
