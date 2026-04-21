import { beforeEach, describe, expect, it, vi } from "vitest";

const { createAgentSession, loaderState } = vi.hoisted(() => ({
  createAgentSession: vi.fn(),
  loaderState: {
    extensions: [] as any[],
  },
}));

vi.mock("@mariozechner/pi-coding-agent", () => ({
  createAgentSession,
  getAgentDir: vi.fn(() => "/tmp/.pi/agent"),
  DefaultResourceLoader: class {
    async reload() {}
    getExtensions() { return { extensions: loaderState.extensions, runtime: {} }; }
    getSkills() { return { skills: [], diagnostics: [] }; }
    getPrompts() { return { prompts: [], diagnostics: [] }; }
    getThemes() { return { themes: [], diagnostics: [] }; }
    getAgentsFiles() { return { agentsFiles: [] }; }
    getSystemPrompt() { return "base prompt"; }
    getAppendSystemPrompt() { return []; }
    getPathMetadata() { return new Map(); }
    extendResources() {}
  },
  SessionManager: { inMemory: vi.fn(() => ({ kind: "memory-session-manager" })) },
  SettingsManager: { create: vi.fn(() => ({ kind: "settings-manager" })) },
}));

vi.mock("../src/agent-types.js", () => ({
  BUILTIN_TOOL_NAMES: ["read", "bash", "edit", "write", "grep", "find", "ls"],
  getConfig: vi.fn(() => ({
    displayName: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: true,
    skills: false,
    promptMode: "replace",
  })),
  getAgentConfig: vi.fn(() => ({
    name: "Explore",
    description: "Explore",
    builtinToolNames: ["read"],
    extensions: true,
    skills: false,
    systemPrompt: "You are Explore.",
    promptMode: "replace",
    inheritContext: false,
    runInBackground: false,
    isolated: false,
  })),
  getMemoryToolNames: vi.fn(() => []),
  getReadOnlyMemoryToolNames: vi.fn(() => []),
  getToolNamesForType: vi.fn(() => ["read"]),
}));

vi.mock("../src/env.js", () => ({
  detectEnv: vi.fn(async () => ({ isGitRepo: false, branch: "", platform: "linux" })),
}));

vi.mock("../src/prompts.js", () => ({
  buildAgentPrompt: vi.fn(() => "system prompt"),
  buildAppendModeSystemPrompt: vi.fn(() => "append prompt"),
}));

vi.mock("../src/memory.js", () => ({
  buildMemoryBlock: vi.fn(() => ""),
  buildReadOnlyMemoryBlock: vi.fn(() => ""),
}));

vi.mock("../src/skill-loader.js", () => ({
  preloadSkills: vi.fn(() => []),
}));

import {
  collectAppendModeToolInfo,
  createAppendModeResourceLoader,
  forwardAbortSignal,
  resumeAgent,
  runAgent,
} from "../src/agent-runner.js";
import { getToolNamesForType } from "../src/agent-types.js";

function createSession(
  finalText: string,
  allTools: Array<{ name: string; sourceInfo?: { source?: string } }> = [{ name: "read" }],
) {
  const listeners: Array<(event: any) => void> = [];
  const session = {
    messages: [] as any[],
    subscribe: vi.fn((listener: (event: any) => void) => {
      listeners.push(listener);
      return () => {};
    }),
    prompt: vi.fn(async () => {
      session.messages.push({
        role: "assistant",
        content: [{ type: "text", text: finalText }],
      });
    }),
    abort: vi.fn(),
    steer: vi.fn(),
    getActiveToolNames: vi.fn(() => ["read"]),
    getAllTools: vi.fn(() => allTools),
    setActiveToolsByName: vi.fn(),
    bindExtensions: vi.fn(async () => {}),
  };
  return { session, listeners };
}

const ctx = {
  cwd: "/tmp",
  model: undefined,
  modelRegistry: { find: vi.fn(), getAvailable: vi.fn(() => []) },
  getSystemPrompt: vi.fn(() => "parent prompt"),
  sessionManager: { getBranch: vi.fn(() => []) },
} as any;

const pi = {} as any;

beforeEach(() => {
  createAgentSession.mockReset();
  loaderState.extensions = [];
  vi.mocked(getToolNamesForType).mockReturnValue(["read"]);
});

describe("agent-runner abort handling", () => {
  it("aborts immediately when the signal is already aborted", () => {
    const session = { abort: vi.fn() } as any;
    const controller = new AbortController();
    controller.abort();

    const cleanup = forwardAbortSignal(session, controller.signal);

    expect(session.abort).toHaveBeenCalledOnce();
    expect(() => cleanup()).not.toThrow();
  });
});

describe("agent-runner final output capture", () => {
  it("returns the final assistant text even when no text_delta events were streamed", async () => {
    const { session } = createSession("LOCKED");
    createAgentSession.mockResolvedValue({ session });

    const result = await runAgent(ctx, "Explore", "Say LOCKED", { pi });

    expect(result.responseText).toBe("LOCKED");
  });

  it("binds extensions before prompting", async () => {
    const { session } = createSession("BOUND");
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Say BOUND", { pi });

    expect(session.bindExtensions).toHaveBeenCalledTimes(1);
    expect(session.bindExtensions).toHaveBeenCalledWith(
      expect.objectContaining({ onError: expect.any(Function) }),
    );

    const bindOrder = session.bindExtensions.mock.invocationCallOrder[0];
    const promptOrder = session.prompt.mock.invocationCallOrder[0];
    expect(bindOrder).toBeLessThan(promptOrder);
  });

  it("passes the allowed tool set into createAgentSession", async () => {
    loaderState.extensions = [{
      tools: new Map([
        ["ext_tool", { definition: { description: "Extension tool" } }],
      ]),
    }];
    const { session } = createSession("TOOLS", [
      { name: "read", sourceInfo: { source: "builtin" } },
      { name: "bash", sourceInfo: { source: "builtin" } },
      { name: "Agent", sourceInfo: { source: "sdk" } },
      { name: "ext_tool", sourceInfo: { source: "test-extension" } },
    ]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Use tools", { pi });

    expect(createAgentSession).toHaveBeenCalledWith(expect.objectContaining({
      tools: ["read", "ext_tool"],
    }));
    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read", "ext_tool"]);
  });

  it("keeps extension overrides of built-in names active", async () => {
    vi.mocked(getToolNamesForType).mockReturnValue([]);
    const { session } = createSession("OVERRIDE", [
      { name: "read", sourceInfo: { source: "sandboxed-extension" } },
      { name: "bash", sourceInfo: { source: "builtin" } },
    ]);
    createAgentSession.mockResolvedValue({ session });

    await runAgent(ctx, "Explore", "Use override", { pi });

    expect(session.setActiveToolsByName).toHaveBeenCalledWith(["read"]);
  });

  it("resumeAgent also falls back to the final assistant message text", async () => {
    const { session } = createSession("RESUMED");

    const result = await resumeAgent(session as any, "Continue");

    expect(result).toBe("RESUMED");
  });
});

describe("agent-runner append-mode loader", () => {
  it("recomputes extension tool metadata from the loader", () => {
    let tools = new Map<string, any>([
      ["ext_a", { definition: { description: "Tool A", promptGuidelines: ["Use ext_a carefully."] } }],
    ]);
    const loader: any = {
      getExtensions: () => ({ extensions: [{ tools }], runtime: {} }),
    };

    expect(collectAppendModeToolInfo(["read"], loader, { extensions: true })).toEqual({
      toolNames: ["read", "ext_a"],
      toolSnippets: { ext_a: "Tool A" },
      promptGuidelines: ["Use ext_a carefully."],
    });

    tools = new Map<string, any>([
      ["ext_b", { definition: { description: "Tool B" } }],
    ]);

    expect(collectAppendModeToolInfo(["read"], loader, { extensions: true })).toEqual({
      toolNames: ["read", "ext_b"],
      toolSnippets: { ext_b: "Tool B" },
      promptGuidelines: [],
    });
  });

  it("preserves runtime skill discovery while hiding duplicated prompt injection", async () => {
    const baseLoader: any = {
      getExtensions: () => ({ extensions: [], runtime: {} }),
      getSkills: () => ({
        skills: [{
          name: "skill-a",
          description: "Do the thing.",
          filePath: "/tmp/skill-a/SKILL.md",
          baseDir: "/tmp/skill-a",
          source: "project",
          disableModelInvocation: false,
        }],
        diagnostics: [{ level: "info", message: "ok" }],
      }),
      getPrompts: () => ({ prompts: [], diagnostics: [] }),
      getThemes: () => ({ themes: [], diagnostics: [] }),
      getAgentsFiles: () => ({ agentsFiles: [{ path: "/tmp/AGENTS.md", content: "rules" }] }),
      getSystemPrompt: () => "base prompt",
      getAppendSystemPrompt: () => ["append rules"],
      getPathMetadata: () => new Map(),
      extendResources: () => {},
      reload: async () => {},
    };

    const loader = createAppendModeResourceLoader(baseLoader, () => "synthesized prompt");

    expect(loader.getSystemPrompt()).toBe("synthesized prompt");
    expect(loader.getAppendSystemPrompt()).toEqual([]);
    expect(loader.getAgentsFiles().agentsFiles).toEqual([]);

    const skills = loader.getSkills();
    expect(skills.skills).toHaveLength(1);
    expect(skills.skills[0].name).toBe("skill-a");
    expect(skills.skills[0].disableModelInvocation).toBe(true);
    expect(skills.diagnostics).toEqual([{ level: "info", message: "ok" }]);

    await expect(loader.reload()).resolves.toBeUndefined();
  });
});
