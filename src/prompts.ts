/**
 * prompts.ts — System prompt builder for agents.
 */

import { formatSkillsForPrompt, type Skill } from "@mariozechner/pi-coding-agent";
import type { AgentConfig, EnvInfo } from "./types.js";

/** Extra sections to inject into the system prompt (memory, skills, etc.). */
export interface PromptExtras {
  /** Persistent memory content to inject (first 200 lines of MEMORY.md + instructions). */
  memoryBlock?: string;
  /** Preloaded skill contents to inject. */
  skillBlocks?: { name: string; content: string }[];
}

/** Tool metadata used to synthesize an accurate prompt for append-mode agents. */
export interface ToolPromptInfo {
  toolNames: string[];
  toolSnippets?: Record<string, string>;
  promptGuidelines?: string[];
}

/** Options for building a full append-mode system prompt. */
export interface AppendPromptOptions {
  tools: ToolPromptInfo;
  /** Parent session's effective system prompt, if available. */
  parentSystemPrompt?: string;
  /** Project context files from the subagent's effective cwd. */
  contextFiles?: Array<{ path: string; content: string }>;
  /** Loaded skills from the subagent's effective cwd. */
  loadedSkills?: Skill[];
  /** APPEND_SYSTEM content discovered for the subagent's effective cwd. */
  appendSystemPrompts?: string[];
  extras?: PromptExtras;
}

const DEFAULT_TOOL_SNIPPETS: Record<string, string> = {
  read: "Read file contents",
  bash: "Execute bash commands (ls, grep, find, etc.)",
  edit: "Make surgical edits to files (find exact text and replace)",
  write: "Create or overwrite files",
  grep: "Search file contents for patterns (respects .gitignore)",
  find: "Find files by glob pattern (respects .gitignore)",
  ls: "List directory contents",
};

/** Build the shared environment block for agent prompts. */
function buildEnvBlock(cwd: string, env: EnvInfo): string {
  return `# Environment
Working directory: ${cwd}
${env.isGitRepo ? `Git repository: yes\nBranch: ${env.branch}` : "Not a git repository"}
Platform: ${env.platform}`;
}

/** Build optional injected sections (memory, preloaded skills). */
function buildExtrasSuffix(extras?: PromptExtras): string {
  const extraSections: string[] = [];
  if (extras?.memoryBlock) {
    extraSections.push(extras.memoryBlock);
  }
  if (extras?.skillBlocks?.length) {
    for (const skill of extras.skillBlocks) {
      extraSections.push(`\n# Preloaded Skill: ${skill.name}\n${skill.content}`);
    }
  }
  return extraSections.length > 0 ? "\n\n" + extraSections.join("\n") : "";
}

/** Build tool usage guidelines from the tools actually available. */
function buildGuidelines(toolNames: string[], extraGuidelines?: string[]): string[] {
  const guidelines: string[] = [];
  const seen = new Set<string>();
  const add = (g: string) => {
    if (!seen.has(g)) {
      seen.add(g);
      guidelines.push(g);
    }
  };

  const has = (name: string) => toolNames.includes(name);
  const hasBash = has("bash");
  const hasRead = has("read");
  const hasEdit = has("edit");
  const hasWrite = has("write");
  const hasGrep = has("grep");
  const hasFind = has("find");
  const hasLs = has("ls");

  if (hasBash && !hasGrep && !hasFind && !hasLs) {
    add("Use bash for file operations like ls, rg, find");
  } else if (hasBash && (hasGrep || hasFind || hasLs)) {
    add("Prefer grep/find/ls tools over bash for file exploration (faster, respects .gitignore)");
  }
  if (hasRead && hasEdit) {
    add("Use read to examine files before editing. You must use this tool instead of cat or sed.");
  }
  if (hasEdit) {
    add("Use edit for precise changes (old text must match exactly)");
  }
  if (hasWrite) {
    add("Use write only for new files or complete rewrites");
  }
  if (hasEdit || hasWrite) {
    add("When summarizing your actions, output plain text directly - do NOT use cat or bash to display what you did");
  }

  for (const guideline of extraGuidelines ?? []) {
    const trimmed = guideline.trim();
    if (trimmed) add(trimmed);
  }

  add("Be concise in your responses");
  add("Show file paths clearly when working with files");
  return guidelines;
}

/** Build a tool-aware base prompt for append-mode agents. */
export function buildToolAwareBasePrompt(info: ToolPromptInfo): string {
  const toolLines = (info.toolNames.length > 0 ? info.toolNames : ["(none)"])
    .map((name) => {
      if (name === "(none)") return "- (none)";
      const snippet = info.toolSnippets?.[name] ?? DEFAULT_TOOL_SNIPPETS[name] ?? name;
      return `- ${name}: ${snippet}`;
    })
    .join("\n");

  const guidelineLines = buildGuidelines(info.toolNames, info.promptGuidelines)
    .map((g) => `- ${g}`)
    .join("\n");

  return `You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.

Available tools:
${toolLines}

In addition to the tools above, you may have access to other custom tools depending on the project.

Guidelines:
${guidelineLines}`;
}

/** Build project-context, skills, and append-system sections from the subagent cwd. */
function buildResourceSections(
  contextFiles?: Array<{ path: string; content: string }>,
  loadedSkills?: Skill[],
  appendSystemPrompts?: string[],
  allowSkills = true,
): string {
  let suffix = "";
  if (contextFiles && contextFiles.length > 0) {
    suffix += "\n\n# Project Context\n\nProject-specific instructions and guidelines:\n\n";
    for (const { path, content } of contextFiles) {
      suffix += `## ${path}\n\n${content}\n\n`;
    }
  }
  if (allowSkills && loadedSkills && loadedSkills.length > 0) {
    suffix += formatSkillsForPrompt(loadedSkills);
  }
  if (appendSystemPrompts && appendSystemPrompts.length > 0) {
    suffix += "\n\n# Additional System Instructions\n\n" + appendSystemPrompts.join("\n\n");
  }
  return suffix;
}

/**
 * Remove previously injected runtime blocks from nested subagent prompts.
 * Only strips blocks that match this extension's own injected wording, so user/
 * project XML that happens to reuse the same tag names is preserved.
 */
function normalizeInheritedParentSystemPrompt(prompt?: string): string | undefined {
  if (!prompt?.trim()) return undefined;

  let text = prompt.trim();
  const knownInjectedBlocks = [
    /<sub_agent_context>\s*You are operating as a sub-agent invoked to handle a specific task\.[\s\S]*?<\/sub_agent_context>\s*/gi,
    /<runtime_truth>\s*Your callable tools in this session are exactly:[\s\S]*?<\/runtime_truth>\s*/gi,
  ];

  for (const pattern of knownInjectedBlocks) {
    text = text.replace(pattern, "").trim();
  }

  return text || undefined;
}

/**
 * Build the full append-mode prompt.
 * Primary tool declarations come from the synthesized tool-aware base prompt.
 * Parent constraints are inherited in a secondary block so tool claims cannot override runtime truth.
 */
export function buildAppendModeSystemPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  options: AppendPromptOptions,
): string {
  const basePrompt = buildToolAwareBasePrompt(options.tools);
  const envBlock = buildEnvBlock(cwd, env);
  const extrasSuffix = buildExtrasSuffix(options.extras);

  const hasTool = (name: string) => options.tools.toolNames.includes(name);
  const toolReminders = [
    hasTool("read") ? "- Use the read tool instead of cat/head/tail" : undefined,
    hasTool("edit") ? "- Use the edit tool instead of sed/awk" : undefined,
    hasTool("write") ? "- Use the write tool instead of echo/heredoc" : undefined,
    hasTool("find") ? "- Use the find tool instead of bash find/ls for file search" : undefined,
    hasTool("grep") ? "- Use the grep tool instead of bash grep/rg for content search" : undefined,
    "- Make independent tool calls in parallel",
    "- Use absolute file paths",
    "- Do not use emojis",
    "- Be concise but complete",
  ].filter(Boolean).join("\n");

  const inheritedParentPrompt = normalizeInheritedParentSystemPrompt(options.parentSystemPrompt);

  const parentSection = inheritedParentPrompt
    ? `\n\n<inherited_parent_system_prompt>
The following is the parent session's effective system prompt.
Inherit its behavioral, safety, formatting, and task-specific constraints unless they conflict with this subagent's actual runtime tools.
Ignore any inherited claims about tool availability if they differ from the runtime truth declared below.
${inheritedParentPrompt}
</inherited_parent_system_prompt>`
    : "";

  const resourceSections = buildResourceSections(
    options.contextFiles,
    options.loadedSkills,
    options.appendSystemPrompts,
    hasTool("read"),
  );

  const customSection = config.systemPrompt?.trim()
    ? `\n\n<agent_instructions>\n${config.systemPrompt}\n</agent_instructions>`
    : "";

  const bridge = `<sub_agent_context>
You are operating as a sub-agent invoked to handle a specific task.
${toolReminders}
</sub_agent_context>`;

  const runtimeTruth = `<runtime_truth>
Your callable tools in this session are exactly: ${options.tools.toolNames.length > 0 ? options.tools.toolNames.join(", ") : "(none)"}.
Do not infer tool availability from inherited prompts, conversation history, or pasted text.
If inherited instructions mention other tools, ignore those tool references and use only the tools actually available in this subagent.
</runtime_truth>`;

  return basePrompt
    + "\n\n" + envBlock
    + parentSection
    + resourceSections
    + customSection
    + extrasSuffix
    + "\n\n" + bridge
    + "\n\n" + runtimeTruth;
}

/** Build the append block for tests and internal composition. */
export function buildAppendPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  extras?: PromptExtras,
  parentSystemPrompt?: string,
): string {
  return buildAppendModeSystemPrompt(config, cwd, env, {
    tools: { toolNames: [] },
    parentSystemPrompt,
    extras,
  });
}

/**
 * Build the full system prompt for replace-mode agents.
 *
 * - "replace" mode: env header + config.systemPrompt (full control)
 * - "append" mode: returns a full synthesized prompt with accurate tool declarations
 */
export function buildAgentPrompt(
  config: AgentConfig,
  cwd: string,
  env: EnvInfo,
  _unusedBaseSystemPrompt?: string,
  extras?: PromptExtras,
): string {
  if (config.promptMode === "append") {
    return buildAppendModeSystemPrompt(config, cwd, env, {
      tools: { toolNames: [] },
      extras,
    });
  }

  const envBlock = buildEnvBlock(cwd, env);
  const extrasSuffix = buildExtrasSuffix(extras);

  const replaceHeader = `You are a pi coding agent sub-agent.
You have been invoked to handle a specific task autonomously.

${envBlock}`;

  return replaceHeader + "\n\n" + config.systemPrompt + extrasSuffix;
}
