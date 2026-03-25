import { afterEach, describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import extension from "../src/index.js";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
};

type RegisteredTool = {
  name: string;
  renderResult?: (result: any, options: { expanded: boolean; isPartial?: boolean }, theme: typeof theme) => any;
};

function createMockPi() {
  const tools: RegisteredTool[] = [];
  const handlers = new Map<string, Array<(...args: any[]) => any>>();

  const pi = {
    registerTool: (tool: RegisteredTool) => { tools.push(tool); },
    registerCommand: () => {},
    registerMessageRenderer: () => {},
    on: (event: string, handler: (...args: any[]) => any) => {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
    sendUserMessage: () => {},
    sendMessage: () => {},
    exec: async () => ({ stdout: "", stderr: "", code: 0, killed: false }),
    events: { emit: () => {} },
  } as unknown as ExtensionAPI;

  extension(pi);

  const agentTool = tools.find((tool) => tool.name === "Agent");
  if (!agentTool?.renderResult) {
    throw new Error("Agent tool was not registered");
  }

  return {
    renderResult: agentTool.renderResult,
    async shutdown() {
      for (const handler of handlers.get("session_shutdown") ?? []) {
        await handler({}, {});
      }
    },
  };
}

function renderLines(renderResult: NonNullable<RegisteredTool["renderResult"]>, result: any, expanded = false) {
  const component = renderResult(result, { expanded, isPartial: false }, theme);
  return component.render(200).map((line: string) => line.trimEnd());
}

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  while (cleanups.length > 0) {
    await cleanups.pop()?.();
  }
});

describe("Agent tool rendering", () => {
  it("shows a bounded preview for completed collapsed results", async () => {
    const registered = createMockPi();
    cleanups.push(registered.shutdown);

    const result = {
      content: [{ type: "text", text: "line 1\nline 2\nline 3\nline 4\nline 5\nline 6\nline 7" }],
      details: {
        displayName: "Review",
        description: "Review current changes",
        subagentType: "Review",
        toolUses: 3,
        tokens: "12.0k token",
        durationMs: 2500,
        status: "completed",
      },
    };

    const lines = renderLines(registered.renderResult, result, false);
    expect(lines.some((line: string) => line.includes("Done"))).toBe(true);
    expect(lines.some((line: string) => line.includes("line 1"))).toBe(true);
    expect(lines.some((line: string) => line.includes("line 6"))).toBe(true);
    expect(lines.some((line: string) => line.includes("more lines truncated"))).toBe(true);
    expect(lines.some((line: string) => line.includes("line 7"))).toBe(false);
  });

  it("truncates long single-line completed output in collapsed view", async () => {
    const registered = createMockPi();
    cleanups.push(registered.shutdown);

    const longLine = "A".repeat(2000);
    const result = {
      content: [{ type: "text", text: longLine }],
      details: {
        displayName: "Review",
        description: "Review current changes",
        subagentType: "Review",
        toolUses: 1,
        tokens: "5.0k token",
        durationMs: 1000,
        status: "completed",
      },
    };

    const lines = renderLines(registered.renderResult, result, false);
    const flattened = lines.join("\n");

    expect(flattened).toContain("Done");
    expect(flattened).toContain("more characters truncated");
    expect(flattened).not.toContain(longLine);
    expect(flattened.length).toBeLessThan(1700);
  });

  it("shows full completed output when expanded", async () => {
    const registered = createMockPi();
    cleanups.push(registered.shutdown);

    const result = {
      content: [{ type: "text", text: "alpha\nbeta\ngamma" }],
      details: {
        displayName: "Review",
        description: "Review current changes",
        subagentType: "Review",
        toolUses: 2,
        tokens: "8.0k token",
        durationMs: 1800,
        status: "completed",
      },
    };

    const lines = renderLines(registered.renderResult, result, true);
    const flattened = lines.join("\n");

    expect(flattened).toContain("alpha");
    expect(flattened).toContain("beta");
    expect(flattened).toContain("gamma");
    expect(flattened).not.toContain("⎿  Done");
  });
});
