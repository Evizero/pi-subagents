/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 10).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import type { Model } from "@mariozechner/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import type { AgentRecord, IsolationMode, SubagentType, ThinkingLevel } from "./types.js";
import { cleanupWorktree, createWorktree, pruneWorktrees, } from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 10;

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

interface SpawnOptions {
  description: string;
  /** Origin of the launch request. */
  origin?: "tool" | "command";
  /** Session that launched the agent. */
  sessionId?: string;
  model?: Model<any>;
  maxTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  isBackground?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private maxConcurrent: number;

  /** Queue of background agents waiting to start. */
  private queue: { id: string; args: SpawnArgs }[] = [];
  /** Number of currently running background agents. */
  private runningBackground = 0;

  constructor(onComplete?: OnAgentComplete, maxConcurrent = DEFAULT_MAX_CONCURRENT, onStart?: OnAgentStart) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      origin: options.origin,
      sessionId: options.sessionId,
      isBackground: options.isBackground,
      promiseSettled: false,
      backgroundSlotReleased: false,
      detached: false,
      abandoned: false,
      notificationDelivered: false,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
    };
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };

    if (options.isBackground && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, args });
      return id;
    }

    this.startAgent(id, record, args);
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);

    // Worktree isolation: create a temporary git worktree if requested
    let worktreeCwd: string | undefined;
    let worktreeWarning = "";
    if (options.isolation === "worktree") {
      const wt = createWorktree(ctx.cwd, id);
      if (wt) {
        record.worktree = wt;
        worktreeCwd = wt.path;
      } else {
        worktreeWarning = "\n\n[WARNING: Worktree isolation was requested but failed (not a git repo, or no commits yet). Running in the main working directory instead.]";
      }
    }

    // Prepend worktree warning to prompt if isolation failed
    const effectivePrompt = worktreeWarning ? worktreeWarning + "\n\n" + prompt : prompt;

    const promise = runAgent(ctx, type, effectivePrompt, {
      pi,
      model: options.model,
      maxTurns: options.maxTurns,
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      cwd: worktreeCwd,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onSessionCreated: (session) => {
        record.session = session;
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          for (const msg of record.pendingSteers) {
            session.steer(msg).catch(() => {});
          }
          record.pendingSteers = undefined;
        }
        options.onSessionCreated?.(session);
      },
    })
      .then(({ responseText, session, aborted, steered }) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = aborted ? "aborted" : steered ? "steered" : "completed";
        }
        record.result = responseText;
        record.session = session;
        record.completedAt ??= Date.now();
        record.promiseSettled = true;

        // Final flush of streaming output file
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Clean up worktree if used
        if (record.worktree) {
          const wtResult = cleanupWorktree(ctx.cwd, record.worktree, options.description);
          record.worktreeResult = wtResult;
          if (wtResult.hasChanges && wtResult.branch) {
            record.result = (record.result ?? "") +
              `\n\n---\nChanges saved to branch \`${wtResult.branch}\`. Merge with: \`git merge ${wtResult.branch}\``;
          }
        }

        if (options.isBackground) {
          if (!record.backgroundSlotReleased) this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return responseText;
      })
      .catch((err) => {
        // Don't overwrite status if externally stopped via abort()
        if (record.status !== "stopped") {
          record.status = "error";
        }
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt ??= Date.now();
        record.promiseSettled = true;

        // Final flush of streaming output file on error
        if (record.outputCleanup) {
          try { record.outputCleanup(); } catch { /* ignore */ }
          record.outputCleanup = undefined;
        }

        // Best-effort worktree cleanup on error
        if (record.worktree) {
          try {
            const wtResult = cleanupWorktree(ctx.cwd, record.worktree, options.description);
            record.worktreeResult = wtResult;
          } catch { /* ignore cleanup errors */ }
        }

        if (options.isBackground) {
          if (!record.backgroundSlotReleased) this.runningBackground--;
          this.onComplete?.(record);
          this.drainQueue();
        }
        return "";
      });

    record.promise = promise;
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      this.startAgent(next.id, record, next.args);
    }
  }

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
  ): Promise<AgentRecord> {
    const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
    const record = this.agents.get(id)!;
    await record.promise;
    return record;
  }

  /**
   * Resume an existing agent session with a new prompt.
   */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
  ): Promise<AgentRecord | undefined> {
    const record = this.agents.get(id);
    if (!record?.session) return undefined;

    record.status = "running";
    record.startedAt = Date.now();
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.notificationDelivered = false;

    try {
      const responseText = await resumeAgent(record.session, prompt, {
        onToolActivity: (activity) => {
          if (activity.type === "end") record.toolUses++;
        },
        signal,
      });
      record.status = "completed";
      record.result = responseText;
      record.completedAt = Date.now();
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : String(err);
      record.completedAt = Date.now();
    }

    return record;
  }

  getRecord(id: string): AgentRecord | undefined {
    const record = this.agents.get(id);
    if (record?.detached) return undefined;
    return record;
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()]
      .filter((record) => !record.detached)
      .sort((a, b) => b.startedAt - a.startedAt);
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    if (record.isBackground && !record.backgroundSlotReleased) {
      record.backgroundSlotReleased = true;
      this.runningBackground = Math.max(0, this.runningBackground - 1);
      this.drainQueue();
    }
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
  }

  /** Hide all records for a session from public lookups/listing while keeping them until safe cleanup. */
  detachSession(sessionId: string | undefined, abandoned = false): void {
    if (!sessionId) return;
    for (const record of this.agents.values()) {
      if (record.sessionId === sessionId) {
        record.detached = true;
        record.abandoned = abandoned;
      }
    }
  }

  /** Hide all records except those belonging to the given session. */
  detachAllExcept(sessionId: string | undefined, abandoned = false): void {
    for (const record of this.agents.values()) {
      const keepVisible = sessionId !== undefined && record.sessionId === sessionId && !record.abandoned;
      record.detached = !keepVisible;
      if (!keepVisible) {
        record.abandoned = abandoned;
      } else {
        record.abandoned = false;
      }
    }
  }

  /** Restore visibility for a previously-detached session (e.g. when /resume returns to it). */
  attachSession(sessionId: string | undefined): void {
    if (!sessionId) return;
    for (const record of this.agents.values()) {
      if (record.sessionId === sessionId && !record.abandoned) {
        record.detached = false;
      }
    }
  }

  /** Remove only detached hard-reset records that are safe to dispose. */
  clearDetachedCompleted(): void {
    for (const [id, record] of this.agents) {
      if (!record.detached || !record.abandoned) continue;
      if (record.status === "running" || record.status === "queued") continue;
      if (record.promise && !record.promiseSettled) continue;
      this.removeRecord(id, record);
    }
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      if (record.promise && !record.promiseSettled) continue;
      // Preserve deferred soft-switch results until the user returns and they are surfaced.
      if (record.detached && !record.abandoned && !record.notificationDelivered && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   */
  clearCompleted(): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (record.promise && !record.promiseSettled) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    let count = 0;
    // Clear queued agents first
    for (const queued of this.queue) {
      const record = this.agents.get(queued.id);
      if (record) {
        record.status = "stopped";
        record.completedAt = Date.now();
        record.promiseSettled = true;
        count++;
      }
    }
    this.queue = [];
    // Abort running agents
    for (const record of this.agents.values()) {
      if (record.status === "running") {
        record.abortController?.abort();
        record.status = "stopped";
        record.completedAt = Date.now();
        if (record.isBackground && !record.backgroundSlotReleased) {
          record.backgroundSlotReleased = true;
          this.runningBackground = Math.max(0, this.runningBackground - 1);
        }
        count++;
      }
    }
    this.drainQueue();
    return count;
  }

  /** Wait for all running and queued agents to complete (including queued ones). */
  async waitForAll(): Promise<void> {
    // Loop because drainQueue respects the concurrency limit — as running
    // agents finish they start queued ones, which need awaiting too.
    while (true) {
      this.drainQueue();
      const pending = [...this.agents.values()]
        .filter(r => r.status === "running" || r.status === "queued")
        .map(r => r.promise)
        .filter(Boolean);
      if (pending.length === 0) break;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
    }
    this.agents.clear();
    // Prune any orphaned git worktrees (crash recovery)
    try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
  }
}
