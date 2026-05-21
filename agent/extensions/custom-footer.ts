import type {
  ExtensionAPI,
  ExtensionContext,
} from "@mariozechner/pi-coding-agent";

const RIGHT_STATUS_ORDER = ["generation-stats", "codex-quotas", "deepseek-balance"] as const;
const RIGHT_STATUS_IDS = new Set<string>(RIGHT_STATUS_ORDER);

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text: string) {
  return stripAnsi(text).length;
}

function truncateToWidth(text: string, width: number, ellipsis = "...") {
  if (visibleWidth(text) <= width) return text;

  const max = Math.max(0, width - visibleWidth(ellipsis));
  const ansiPattern = /\x1b\[[0-9;]*m/g;
  let result = "";
  let visible = 0;
  let index = 0;
  let sawAnsi = false;

  for (const match of text.matchAll(ansiPattern)) {
    const ansiIndex = match.index ?? 0;
    const plain = text.slice(index, ansiIndex);
    const take = Math.max(0, Math.min(plain.length, max - visible));
    result += plain.slice(0, take);
    visible += take;
    if (visible >= max) break;

    result += match[0];
    sawAnsi = true;
    index = ansiIndex + match[0].length;
  }

  if (visible < max) {
    const plain = text.slice(index);
    const take = Math.max(0, Math.min(plain.length, max - visible));
    result += plain.slice(0, take);
  }

  return result + ellipsis + (sawAnsi ? "\x1b[0m" : "");
}

function sanitizeStatusText(text: string) {
  return text.replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function footerText(theme: { fg(color: "text", text: string): string }, text: string) {
  return theme.fg("text", text);
}

function installFooter(pi: ExtensionAPI, ctx: ExtensionContext) {
  ctx.ui.setFooter((tui, theme, footerData) => {
    const unsub = footerData.onBranchChange(() => tui.requestRender());

    return {
      dispose() {
        unsub();
      },
      invalidate() {},
      render(width: number): string[] {
        let totalInput = 0;
        let totalOutput = 0;
        let totalCacheRead = 0;
        let totalCacheWrite = 0;
        let totalCost = 0;

        for (const entry of ctx.sessionManager.getEntries()) {
          if (entry.type === "message" && entry.message.role === "assistant") {
            totalInput += entry.message.usage.input;
            totalOutput += entry.message.usage.output;
            totalCacheRead += entry.message.usage.cacheRead;
            totalCacheWrite += entry.message.usage.cacheWrite;
            totalCost += entry.message.usage.cost.total;
          }
        }

        let pwd = ctx.sessionManager.getCwd();
        const home = process.env.HOME || process.env.USERPROFILE;
        if (home && pwd.startsWith(home)) pwd = `~${pwd.slice(home.length)}`;

        const branch = footerData.getGitBranch();
        if (branch) pwd = `${pwd} (${branch})`;

        const sessionName = ctx.sessionManager.getSessionName();
        if (sessionName) pwd = `${pwd} • ${sessionName}`;

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(footerText(theme, `↑${formatTokens(totalInput)}`));
        if (totalOutput) statsParts.push(footerText(theme, `↓${formatTokens(totalOutput)}`));
        if (totalCacheRead) statsParts.push(footerText(theme, `R${formatTokens(totalCacheRead)}`));
        if (totalCacheWrite) statsParts.push(footerText(theme, `W${formatTokens(totalCacheWrite)}`));

        const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
        if (totalCost || usingSubscription) {
          statsParts.push(footerText(theme, `$${totalCost.toFixed(3)}${usingSubscription ? " (sub)" : ""}`));
        }

        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextPercent = contextUsage?.percent !== null ? contextPercentValue.toFixed(1) : "?";
        const contextDisplay = `${contextPercent}%/${formatTokens(contextWindow)}`;
        statsParts.push(
          contextPercentValue > 90
            ? theme.fg("error", contextDisplay)
            : contextPercentValue > 70
              ? theme.fg("warning", contextDisplay)
              : footerText(theme, contextDisplay),
        );

        let statsLeft = statsParts.join(" ");
        let statsLeftWidth = visibleWidth(statsLeft);
        if (statsLeftWidth > width) {
          statsLeft = truncateToWidth(statsLeft, width, "...");
          statsLeftWidth = visibleWidth(statsLeft);
        }

        const modelName = ctx.model?.id || "no-model";
        let rightSideWithoutProvider = modelName;
        if (ctx.model?.reasoning) {
          const thinkingLevel = pi.getThinkingLevel();
          rightSideWithoutProvider = thinkingLevel === "off" ? `${modelName} thinking off` : `${modelName} ${thinkingLevel}`;
        }

        let rightSide = footerText(theme, rightSideWithoutProvider);

        const extensionStatuses = footerData.getExtensionStatuses();
        const rightStatuses = RIGHT_STATUS_ORDER
          .map((key) => extensionStatuses.get(key))
          .filter((text): text is string => Boolean(text))
          .map((text) => sanitizeStatusText(text));
        if (rightStatuses.length > 0) rightSide = `${rightStatuses.join("  ")}  ${rightSide}`;

        const rightSideWidth = visibleWidth(rightSide);
        const totalNeeded = statsLeftWidth + 2 + rightSideWidth;
        let statsLine: string;
        if (totalNeeded <= width) {
          statsLine = statsLeft + " ".repeat(width - statsLeftWidth - rightSideWidth) + rightSide;
        } else {
          const availableForRight = width - statsLeftWidth - 2;
          if (availableForRight > 0) {
            const truncatedRight = truncateToWidth(rightSide, availableForRight, "");
            statsLine = statsLeft + " ".repeat(Math.max(0, width - statsLeftWidth - visibleWidth(truncatedRight))) + truncatedRight;
          } else {
            statsLine = statsLeft;
          }
        }

        const lines = [
          truncateToWidth(footerText(theme, pwd), width, footerText(theme, "...")),
          statsLine,
        ];

        const statusLine = Array.from(extensionStatuses.entries())
          .filter(([key]) => !RIGHT_STATUS_IDS.has(key))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeStatusText(text))
          .join(" ");
        if (statusLine) lines.push(truncateToWidth(statusLine, width, footerText(theme, "...")));

        return lines;
      },
    };
  });
}

export default function rightStatusFooterExtension(pi: ExtensionAPI) {
  pi.on("session_start", (_event, ctx) => {
    installFooter(pi, ctx);
  });

  pi.on("model_select", (_event, ctx) => {
    installFooter(pi, ctx);
  });

  pi.on("thinking_level_select", (_event, ctx) => {
    installFooter(pi, ctx);
  });

  pi.on("session_shutdown", (_event, ctx) => {
    ctx.ui.setFooter(undefined);
  });
}
