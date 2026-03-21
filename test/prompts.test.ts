import { beforeEach, describe, expect, it } from "vitest";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { buildAgentPrompt, buildAppendModeSystemPrompt, buildToolAwareBasePrompt } from "../src/prompts.js";
import type { AgentConfig, EnvInfo } from "../src/types.js";

const env: EnvInfo = {
  isGitRepo: true,
  branch: "main",
  platform: "darwin",
};

const envNoGit: EnvInfo = {
  isGitRepo: false,
  branch: "",
  platform: "linux",
};

beforeEach(() => {
  registerAgents(new Map());
});

function getDefaultConfig(name: string): AgentConfig {
  return getAgentConfig(name)!;
}

describe("prompts", () => {
  it("buildToolAwareBasePrompt lists actual tools", () => {
    const prompt = buildToolAwareBasePrompt({
      toolNames: ["read", "edit"],
      toolSnippets: { read: "Read file contents", edit: "Edit files precisely" },
    });
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- read: Read file contents");
    expect(prompt).toContain("- edit: Edit files precisely");
    expect(prompt).not.toContain("- bash:");
  });

  it("buildToolAwareBasePrompt derives guidelines from available tools", () => {
    const prompt = buildToolAwareBasePrompt({ toolNames: ["read", "edit", "grep", "find", "ls", "write"] });
    expect(prompt).toContain("Use read to examine files before editing");
    expect(prompt).toContain("Use write only for new files or complete rewrites");
    expect(prompt).toContain("Show file paths clearly when working with files");
  });

  it("replace mode includes cwd and git info", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("/workspace");
    expect(prompt).toContain("Branch: main");
    expect(prompt).toContain("darwin");
  });

  it("handles non-git repos", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", envNoGit);
    expect(prompt).toContain("Not a git repository");
    expect(prompt).not.toContain("Branch:");
  });

  it("Explore prompt is read-only", () => {
    const config = getDefaultConfig("Explore");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("file search specialist");
  });

  it("Review prompt is read-only and review-focused", () => {
    const config = getDefaultConfig("Review");
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).toContain("READ-ONLY");
    expect(prompt).toContain("code review specialist");
    expect(prompt).toContain("Findings");
  });

  it("append mode produces a full tool-aware prompt", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAppendModeSystemPrompt(config, "/workspace", env, {
      tools: { toolNames: ["read", "edit"] },
    });
    expect(prompt).toContain("Available tools:");
    expect(prompt).toContain("- read: Read file contents");
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).not.toContain("- bash:");
  });

  it("append mode can inherit the parent effective system prompt", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Extra custom instructions here.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAppendModeSystemPrompt(config, "/workspace", env, {
      tools: { toolNames: ["read"] },
      parentSystemPrompt: "Parent says output JSON only.",
    });
    expect(prompt).toContain("<inherited_parent_system_prompt>");
    expect(prompt).toContain("Parent says output JSON only.");
    expect(prompt).toContain("treat the primary system prompt above as authoritative");
    expect(prompt).toContain("<agent_instructions>");
  });

  it("append mode only mentions tool-specific reminders for available tools", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAppendModeSystemPrompt(config, "/workspace", env, {
      tools: { toolNames: ["bash"] },
    });
    expect(prompt).not.toContain("Use the read tool instead of cat");
    expect(prompt).not.toContain("Use the edit tool instead of sed");
    expect(prompt).not.toContain("Use the write tool instead of echo");
    expect(prompt).not.toContain("Use the find tool instead of bash find/ls");
    expect(prompt).not.toContain("Use the grep tool instead of bash grep/rg");
    expect(prompt).toContain("Make independent tool calls in parallel");
  });

  it("append mode does not expose skills when read is unavailable", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAppendModeSystemPrompt(config, "/workspace", env, {
      tools: { toolNames: ["bash"] },
      loadedSkills: [{
        name: "skill-a",
        description: "Do the thing.",
        filePath: "/tmp/skill-a/SKILL.md",
        baseDir: "/tmp/skill-a",
        source: "project",
        disableModelInvocation: false,
      } as any],
    });
    expect(prompt).not.toContain("skill-a");
  });

  it("append mode includes project context and skills even when parent prompt exists", () => {
    const config: AgentConfig = {
      name: "appender",
      description: "Appender",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAppendModeSystemPrompt(config, "/workspace", env, {
      tools: { toolNames: ["read"] },
      parentSystemPrompt: "Parent says be strict.",
      contextFiles: [{ path: "/workspace/CLAUDE.md", content: "Project rules" }],
      loadedSkills: [{
        name: "skill-a",
        description: "Do the thing.",
        filePath: "/tmp/skill-a/SKILL.md",
        baseDir: "/tmp/skill-a",
        source: "project",
        disableModelInvocation: false,
      } as any],
      appendSystemPrompts: ["Additional local append instructions."],
    });
    expect(prompt).toContain("<inherited_parent_system_prompt>");
    expect(prompt).toContain("Project Context");
    expect(prompt).toContain("CLAUDE.md");
    expect(prompt).toContain("Project rules");
    expect(prompt).toContain("skill-a");
    expect(prompt).toContain("Additional System Instructions");
    expect(prompt).toContain("Additional local append instructions.");
  });

  it("append mode respects tool snippets and guidelines", () => {
    const config = getDefaultConfig("general-purpose");
    const prompt = buildAppendModeSystemPrompt(config, "/workspace", env, {
      tools: {
        toolNames: ["read", "my_tool"],
        toolSnippets: { my_tool: "Custom helper" },
        promptGuidelines: ["Use my_tool for summaries."],
      },
    });
    expect(prompt).toContain("- my_tool: Custom helper");
    expect(prompt).toContain("Use my_tool for summaries.");
  });

  it("replace mode ignores the base prompt argument", () => {
    const config: AgentConfig = {
      name: "standalone",
      description: "Standalone",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a standalone agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, "SECRET base prompt content");
    expect(prompt).toContain("You are a standalone agent.");
    expect(prompt).not.toContain("SECRET base prompt content");
    expect(prompt).not.toContain("<sub_agent_context>");
  });

  it("injects memory block in replace mode", () => {
    const config: AgentConfig = {
      name: "mem-agent",
      description: "Memory Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a memory agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = { memoryBlock: "# Agent Memory\nYou have persistent memory at /tmp/mem/" };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("You are a memory agent.");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("persistent memory");
  });

  it("injects memory block in append mode", () => {
    const config: AgentConfig = {
      name: "mem-append",
      description: "Memory Append",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Custom instructions.",
      promptMode: "append",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = { memoryBlock: "# Agent Memory\nPersistent memory here." };
    const prompt = buildAppendModeSystemPrompt(config, "/workspace", env, {
      tools: { toolNames: ["read"] },
      extras,
    });
    expect(prompt).toContain("<sub_agent_context>");
    expect(prompt).toContain("Agent Memory");
    expect(prompt).toContain("Custom instructions.");
  });

  it("injects preloaded skill blocks", () => {
    const config: AgentConfig = {
      name: "skill-agent",
      description: "Skill Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "You are a skill agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = {
      skillBlocks: [
        { name: "api-conventions", content: "Use REST endpoints." },
        { name: "error-handling", content: "Handle errors gracefully." },
      ],
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("Preloaded Skill: api-conventions");
    expect(prompt).toContain("Use REST endpoints.");
    expect(prompt).toContain("Preloaded Skill: error-handling");
    expect(prompt).toContain("Handle errors gracefully.");
  });

  it("injects both memory and skills", () => {
    const config: AgentConfig = {
      name: "full-agent",
      description: "Full Agent",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Full agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const extras = {
      memoryBlock: "# Memory\nRemember this.",
      skillBlocks: [{ name: "skill1", content: "Skill content." }],
    };
    const prompt = buildAgentPrompt(config, "/workspace", env, undefined, extras);
    expect(prompt).toContain("# Memory");
    expect(prompt).toContain("Preloaded Skill: skill1");
  });

  it("no extras means no extra sections in replace mode", () => {
    const config: AgentConfig = {
      name: "plain",
      description: "Plain",
      builtinToolNames: [],
      extensions: true,
      skills: true,
      systemPrompt: "Plain agent.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
    };
    const prompt = buildAgentPrompt(config, "/workspace", env);
    expect(prompt).not.toContain("Agent Memory");
    expect(prompt).not.toContain("Preloaded Skill");
  });
});
