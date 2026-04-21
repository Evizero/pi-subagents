import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";

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

type RegisteredTool = {
  name: string;
  execute?: (toolCallId: string, params: any, signal: AbortSignal | undefined, onUpdate: any, ctx: any) => Promise<any>;
};

function createMockPi() {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();
  const sendUserMessage = vi.fn();

  const pi = {
    registerTool: (tool: RegisteredTool) => { tools.push(tool); },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: (event: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage,
    sendMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    events: { emit: () => {} },
  } as unknown as ExtensionAPI;

  extension(pi);

  const getResultTool = tools.find((tool) => tool.name === "get_subagent_result");
  if (!getResultTool?.execute) {
    throw new Error("get_subagent_result tool was not registered");
  }

  return {
    getResultExecute: getResultTool.execute,
    sendUserMessage,
    async shutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({}, {});
      }
    },
  };
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  vi.mocked(runAgent).mockReset();
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("get_subagent_result", () => {
  it("waits for stopping agents to fully unwind when wait=true", async () => {
    const registered = createMockPi();
    cleanups.push(registered.shutdown);

    let finishRun!: () => void;
    vi.mocked(runAgent).mockImplementation((_ctx, _type, _prompt, options: any) =>
      new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          finishRun = () => resolve({
            responseText: "stopped output",
            session: {
              dispose: vi.fn(),
              getSessionStats: () => ({ tokens: { total: 0 } }),
            } as any,
            aborted: false,
            steered: false,
          });
        }, { once: true });
      }),
    );

    const manager = (globalThis as any)[Symbol.for("pi-subagents:manager")];
    const id = manager.spawn({} as any, { cwd: "/tmp" } as any, "general-purpose", "test", {
      description: "test",
      isBackground: true,
    });

    manager.getRecord(id).stopRequested = true;
    manager.getRecord(id).abortController.abort();
    expect(manager.getRecord(id).stopRequested).toBe(true);

    const pending = registered.getResultExecute("call-1", { agent_id: id, wait: true }, undefined, undefined, {} as any);

    let settled = false;
    pending.then(() => {
      settled = true;
    });
    await Promise.resolve();
    expect(settled).toBe(false);

    finishRun();
    const result = await pending;
    const text = result.content[0].text as string;

    expect(text).toContain("Status: stopped");
    expect(text).toContain("stopped output");
    expect(text).not.toContain("cancellation has been requested");
    expect(registered.sendUserMessage).not.toHaveBeenCalled();
  });
});
