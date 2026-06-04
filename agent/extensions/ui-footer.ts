import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

const RIGHT_STATUS_ORDER = ["generation-stats", "codex-usage", "deepseek-balance", "openrouter-balance"] as const;
const RIGHT_STATUS_IDS = new Set<string>(RIGHT_STATUS_ORDER);

type ThemeColor =
  | "text"
  | "muted"
  | "error"
  | "warning"
  | "thinkingOff"
  | "thinkingMinimal"
  | "thinkingLow"
  | "thinkingMedium"
  | "thinkingHigh"
  | "thinkingXhigh";

type FooterTheme = {
  fg(color: ThemeColor, text: string): string;
};

const THINKING_LEVEL_COLOR: Record<string, ThemeColor> = {
  off: "thinkingOff",
  minimal: "thinkingMinimal",
  low: "thinkingLow",
  medium: "thinkingMedium",
  high: "thinkingHigh",
  xhigh: "thinkingXhigh",
};

function stripAnsi(text: string) {
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

function visibleWidth(text: string) {
  return stripAnsi(text).length;
}

function truncateToWidth(text: string, width: number, ellipsis = "...") {
  if (width <= 0) return "";
  if (visibleWidth(text) <= width) return text;
  if (visibleWidth(ellipsis) > width) return stripAnsi(ellipsis).slice(0, width);

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
  return stripAnsi(text).replace(/[\r\n\t]/g, " ").replace(/ +/g, " ").trim();
}

function formatTokens(count: number) {
  if (count < 1000) return count.toString();
  if (count < 10000) return `${(count / 1000).toFixed(1)}k`;
  if (count < 1000000) return `${Math.round(count / 1000)}k`;
  if (count < 10000000) return `${(count / 1000000).toFixed(1)}M`;
  return `${Math.round(count / 1000000)}M`;
}

function formatProjectLabel(cwd: string, branch: string | null) {
  const home = process.env.HOME || process.env.USERPROFILE;
  let project = cwd;
  if (home && project.startsWith(home)) project = `~${project.slice(home.length)}`;
  return `${project}${branch ? ` (${branch})` : ""}`;
}

function formatModelLabel(modelId: string | undefined, reasoning: boolean | undefined, thinkingLevel: string) {
  const modelName = modelId || "no-model";
  if (!reasoning) return modelName;
  return thinkingLevel === "off" ? `${modelName} thinking off` : `${modelName} ${thinkingLevel}`;
}

function thinkingLevelColor(level: string | undefined) {
  return THINKING_LEVEL_COLOR[level ?? ""] ?? "thinkingLow";
}

function footerText(theme: FooterTheme, thinkingLevel: string, text: string) {
  return theme.fg(thinkingLevelColor(thinkingLevel), text);
}

function twoColumnLine(left: string, right: string, width: number) {
  let leftText = left;
  let rightText = right;
  let leftWidth = visibleWidth(leftText);
  let rightWidth = visibleWidth(rightText);

  if (leftWidth + 2 + rightWidth > width) {
    const maxRight = Math.max(0, Math.floor((width - 2) / 2));
    rightText = truncateToWidth(rightText, maxRight, "...");
    rightWidth = visibleWidth(rightText);
  }

  if (leftWidth + 2 + rightWidth > width) {
    leftText = truncateToWidth(leftText, Math.max(0, width - rightWidth - 2), "...");
    leftWidth = visibleWidth(leftText);
  }

  if (!rightText) return leftText;
  if (!leftText) return " ".repeat(Math.max(0, width - rightWidth)) + rightText;
  return leftText + " ".repeat(Math.max(1, width - leftWidth - rightWidth)) + rightText;
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
        const horizontalPadding = 2;
        const contentWidth = Math.max(0, width - horizontalPadding * 2);
        const padLine = (line: string) =>
          " ".repeat(horizontalPadding) + line + " ".repeat(Math.max(0, contentWidth - visibleWidth(line))) + " ".repeat(horizontalPadding);

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

        const thinkingLevel = pi.getThinkingLevel();
        const infoLeft = footerText(theme, thinkingLevel, formatProjectLabel(ctx.cwd, footerData.getGitBranch()));
        const infoRight = footerText(theme, thinkingLevel, formatModelLabel(ctx.model?.id, ctx.model?.reasoning, thinkingLevel));

        const statsParts: string[] = [];
        if (totalInput) statsParts.push(footerText(theme, thinkingLevel, `↑${formatTokens(totalInput)}`));
        if (totalOutput) statsParts.push(footerText(theme, thinkingLevel, `↓${formatTokens(totalOutput)}`));
        if (totalCacheRead) statsParts.push(footerText(theme, thinkingLevel, `R${formatTokens(totalCacheRead)}`));
        if (totalCacheWrite) statsParts.push(footerText(theme, thinkingLevel, `W${formatTokens(totalCacheWrite)}`));

        const usingSubscription = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
        if (totalCost || usingSubscription) {
          statsParts.push(footerText(theme, thinkingLevel, `$${totalCost.toFixed(3)}`));
        }

        const contextUsage = ctx.getContextUsage();
        const contextWindow = contextUsage?.contextWindow ?? ctx.model?.contextWindow ?? 0;
        const contextPercentValue = contextUsage?.percent ?? 0;
        const contextTokens = contextUsage?.tokens ?? Math.round(contextWindow * contextPercentValue / 100);
        statsParts.push(footerText(theme, thinkingLevel, `${formatTokens(contextTokens)}/${formatTokens(contextWindow)}`));

        const extensionStatuses = footerData.getExtensionStatuses();
        const prioritizedStatuses = RIGHT_STATUS_ORDER
          .map((key) => extensionStatuses.get(key))
          .filter((text): text is string => Boolean(text))
          .map((text) => sanitizeStatusText(text));
        const otherStatuses = Array.from(extensionStatuses.entries())
          .filter(([key]) => !RIGHT_STATUS_IDS.has(key))
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([, text]) => sanitizeStatusText(text));
        const statusText = [...prioritizedStatuses, ...otherStatuses].filter(Boolean).join("  ");
        const statusRight = statusText ? footerText(theme, thinkingLevel, statusText) : "";

        const statsLeft = statsParts.join(" ");
        const infoLine = twoColumnLine(infoLeft, infoRight, contentWidth);
        const statsLine = twoColumnLine(statsLeft, statusRight, contentWidth);

        return [padLine(infoLine), padLine(statsLine)];
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
