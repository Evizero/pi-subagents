import type { AgentRecord } from "../types.js";

export type ReportWidgetUI = {
  setWidget(
    key: string,
    content: string[] | ((tui: any, theme: any) => { render(): string[]; invalidate(): void; }) | undefined,
    options?: { placement?: "aboveEditor" | "belowEditor" },
  ): void;
};

interface ReportWidgetEntry {
  id: string;
  sessionId?: string;
  title: string;
  meta: string;
  previewLines: string[];
}

export interface ShowReportOptions {
  id: string;
  sessionId?: string;
  title: string;
  meta: string;
  text: string;
}

export class ReportWidgetController {
  private ui: ReportWidgetUI | undefined;
  private currentSessionId: string | undefined;
  private entries: ReportWidgetEntry[] = [];
  private pruneInterval: ReturnType<typeof setInterval>;

  constructor(
    private getRecord: (id: string) => AgentRecord | undefined,
    private maxEntries = 3,
    private maxLines = 12,
    private maxChars = 6_000,
    pruneIntervalMs = 30_000,
  ) {
    this.pruneInterval = setInterval(() => {
      if (this.entries.length === 0) return;
      this.render();
    }, pruneIntervalMs);
  }

  setUI(ui: ReportWidgetUI | undefined) {
    if (this.ui !== ui) {
      this.ui = ui;
      this.render();
    }
  }

  setSessionId(sessionId: string | undefined) {
    if (this.currentSessionId !== sessionId) {
      this.currentSessionId = sessionId;
      this.render();
    }
  }

  show({ id, sessionId, title, meta, text }: ShowReportOptions) {
    if (sessionId && this.currentSessionId && sessionId !== this.currentSessionId) return;

    this.entries = [
      {
        id,
        sessionId,
        title,
        meta,
        previewLines: this.truncatePreview(text),
      },
      ...this.entries.filter((entry) => entry.id !== id),
    ].slice(0, this.maxEntries);

    this.render();
  }

  clear() {
    this.entries = [];
    this.render();
  }

  dispose() {
    clearInterval(this.pruneInterval);
    this.entries = [];
    this.render();
    this.ui = undefined;
  }

  private truncatePreview(text: string): string[] {
    const cappedText = text.length > this.maxChars
      ? text.slice(0, this.maxChars) + `\n... (${text.length - this.maxChars} more characters truncated)`
      : text;
    const lines = cappedText.split("\n");
    if (lines.length <= this.maxLines) return lines;
    return [
      ...lines.slice(0, this.maxLines),
      `... (${lines.length - this.maxLines} more lines truncated)`,
    ];
  }

  private pruneEntries() {
    this.entries = this.entries.filter((entry) => {
      if (this.currentSessionId && entry.sessionId !== this.currentSessionId) return false;
      return this.getRecord(entry.id) !== undefined;
    });
  }

  private render() {
    if (!this.ui) return;

    this.pruneEntries();
    if (this.entries.length === 0) {
      this.ui.setWidget("subagent-report", undefined, { placement: "belowEditor" });
      return;
    }

    const lines: string[] = [];
    for (const [index, entry] of this.entries.entries()) {
      if (index > 0) lines.push("");
      lines.push(`╭─ [subagent report] ${entry.title}`);
      lines.push(`│  ${entry.meta}`);
      if (entry.previewLines.length > 0) {
        lines.push("│");
        for (const line of entry.previewLines) {
          lines.push(`│  ${line}`);
        }
      }
      lines.push("╰─");
    }

    this.ui.setWidget("subagent-report", lines, { placement: "belowEditor" });
  }
}
