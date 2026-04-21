import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../src/agent-runner.js", async () => {
  const actual = await vi.importActual<any>("../src/agent-runner.js");
  return {
    ...actual,
    runAgent: vi.fn(),
    resumeAgent: vi.fn(),
    steerAgent: vi.fn(),
    getAgentConversation: vi.fn(() => ""),
    getDefaultMaxTurns: vi.fn(() => 50),
    setDefaultMaxTurns: vi.fn(),
    getGraceTurns: vi.fn(() => 5),
    setGraceTurns: vi.fn(),
  };
});

import { runAgent } from "../src/agent-runner.js";
import extension from "../src/index.js";

function flushMicrotasks() {
  return Promise.resolve();
}

function createUI() {
  return {
    setWidget: vi.fn(),
    setStatus: vi.fn(),
  };
}

function createCtx(sessionId: string, options: { hasUI: boolean; sessionFile?: string }) {
  return {
    hasUI: options.hasUI,
    cwd: "/tmp",
    ui: createUI(),
    model: undefined,
    modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
    getSystemPrompt: vi.fn(() => "parent prompt"),
    sessionManager: {
      getSessionId: vi.fn(() => sessionId),
      getSessionFile: vi.fn(() => options.sessionFile),
    },
  } as any;
}

function createMockPi() {
  const tools: any[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const sendMessage = vi.fn();

  const pi = {
    registerTool: (tool: any) => { tools.push(tool); },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: (event: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage: () => {},
    sendMessage,
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    events: { emit: vi.fn() },
    appendEntry: vi.fn(),
  } as unknown as ExtensionAPI;

  extension(pi);

  return {
    handlers,
    sendMessage,
    async emit(event: string, payload: any, ctx: any) {
      for (const handler of handlers.get(event) ?? []) {
        await handler(payload, ctx);
      }
    },
    async shutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({}, {});
      }
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(async () => {
  vi.mocked(runAgent).mockReset();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
});

describe("subagent session lifecycle isolation", () => {
  it("ignores child session_start events from ephemeral subagent sessions", async () => {
    const registered = createMockPi();
    cleanups.push(registered.shutdown);

    const parentCtx = createCtx("parent-session", { hasUI: true, sessionFile: "/tmp/parent.jsonl" });
    const childCtx = createCtx("child-session", { hasUI: false, sessionFile: undefined });

    await registered.emit("session_start", {}, parentCtx);

    vi.mocked(runAgent).mockImplementation(() => new Promise(() => {}));

    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const id = manager.spawn({} as any, parentCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
      sessionId: "parent-session",
    });

    expect(manager.getRecord(id)?.status).toBe("running");

    await registered.emit("session_start", {}, childCtx);

    expect(manager.getRecord(id)?.status).toBe("running");
  });

  it("does not let child tool events steal the current interactive session", async () => {
    const registered = createMockPi();
    cleanups.push(registered.shutdown);

    const parentCtx = createCtx("parent-session", { hasUI: true, sessionFile: "/tmp/parent.jsonl" });
    const childCtx = createCtx("child-session", { hasUI: false, sessionFile: undefined });

    await registered.emit("session_start", {}, parentCtx);

    let resolveRun!: (value: any) => void;
    vi.mocked(runAgent).mockImplementation(() => new Promise((resolve) => {
      resolveRun = resolve;
    }));

    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const id = manager.spawn({} as any, parentCtx, "general-purpose", "test", {
      description: "test",
      isBackground: true,
      sessionId: "parent-session",
    });

    await registered.emit("agent_start", {}, childCtx);
    await registered.emit("tool_execution_start", {}, childCtx);

    resolveRun({
      responseText: "done",
      session: {
        dispose: vi.fn(),
        getSessionStats: () => ({ tokens: { total: 0 } }),
      },
      aborted: false,
      steered: false,
    });

    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(250);
    await flushMicrotasks();

    expect(manager.getRecord(id)?.status).toBe("completed");
    expect(registered.sendMessage).toHaveBeenCalledTimes(1);
  });
});
