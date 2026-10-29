import { createTranslator } from "../../i18n/translate";
import type { TranslateFn } from "../../i18n/types";

// 默认 en 翻译器：直调（旧测试/无上下文场景）保持英文断言不变；运行时传 zh 的 t 即中文。
const enT = createTranslator("en");

const toolActionLabelKeys: Record<string, string> = {
  list_data_sources: "stepLabels.list_data_sources",
  inspect_schema: "stepLabels.inspect_schema",
  preview_table: "stepLabels.preview_table",
  run_sql_readonly: "stepLabels.run_sql_readonly",
  retrieve_knowledge: "stepLabels.retrieve_knowledge",
  read_file: "stepLabels.read_file",
  edit_file: "stepLabels.edit_file",
  write_file: "stepLabels.write_file",
  list_files: "stepLabels.list_files",
  grep: "stepLabels.grep",
  mkdir: "stepLabels.mkdir",
  file_stat: "stepLabels.file_stat",
  execute_command: "stepLabels.execute_command",
  promote_workspace_file: "stepLabels.promote_workspace_file",
  task_write: "stepLabels.task_write",
  task_update: "stepLabels.task_update",
  task_complete: "stepLabels.task_complete",
  task_check: "stepLabels.task_check",
  ask_user: "stepLabels.ask_user",
  submit_plan: "stepLabels.submit_plan",
};

const SUMMARY_PREVIEW_MAX = 48;

const fileToolNames = new Set(["read_file", "edit_file", "write_file"]);
const dataToolNames = new Set([
  "list_data_sources",
  "inspect_schema",
  "preview_table",
  "run_sql_readonly",
]);
const workspaceToolNames = new Set([
  "list_files",
  "grep",
  "mkdir",
  "file_stat",
  "execute_command",
  "promote_workspace_file",
  "task_write",
  "task_update",
  "task_complete",
  "task_check",
]);

/** Strip MCP namespace prefix so `mcp__server__inspect_schema` resolves like `inspect_schema`. */
export function normalizeToolLookupName(toolName: string): string {
  const trimmed = toolName.trim();
  if (!trimmed.startsWith("mcp__")) {
    return trimmed;
  }
  const parts = trimmed.split("__");
  if (parts.length >= 3) {
    return parts.slice(2).join("__");
  }
  return trimmed;
}

export function isDisplayableToolName(toolName: string): boolean {
  const trimmed = toolName.trim();
  if (!trimmed) return false;
  const normalized = normalizeToolLookupName(trimmed).toLowerCase();
  return normalized !== "tool" && normalized !== "unknown";
}

function formatSnakeCaseLabel(toolName: string): string {
  return toolName
    .split("_")
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ");
}

function resolveSingleToolStepActionLabel(toolName: string, t: TranslateFn = enT): string {
  const trimmed = toolName.trim();
  if (!trimmed) return t("stepLabels.thinking");

  const direct = toolActionLabelKeys[trimmed];
  if (direct) return t(direct);

  const lookupName = normalizeToolLookupName(trimmed);
  const lookupKey = toolActionLabelKeys[lookupName];
  if (lookupKey) return t(lookupKey);

  if (/[\u4e00-\u9fff]/.test(trimmed)) {
    return trimmed;
  }

  if (lookupName !== trimmed) {
    const namespacedKey = toolActionLabelKeys[lookupName];
    if (namespacedKey) return t(namespacedKey);
  }

  if (trimmed.includes("_")) {
    return formatSnakeCaseLabel(lookupName);
  }

  return trimmed;
}

export function resolveToolStepActionLabel(toolNames: string[], t: TranslateFn = enT): string {
  const normalized = toolNames
    .map((name) => name.trim())
    .filter((name) => isDisplayableToolName(name));
  const unique = [...new Set(normalized)];
  if (unique.length === 0) return t("stepLabels.thinking");
  if (unique.length === 1) {
    if (normalized.length > 1) {
      return t("stepLabels.parallelTools", { count: normalized.length });
    }
    return resolveSingleToolStepActionLabel(unique[0], t);
  }

  if (unique.every((name) => fileToolNames.has(name))) return t("stepLabels.handleFiles");
  if (unique.every((name) => dataToolNames.has(name))) return t("stepLabels.analyzeData");
  if (unique.every((name) => workspaceToolNames.has(name))) return t("stepLabels.operateWorkspace");

  const firstKnown = unique.find((name) => toolActionLabelKeys[name]);
  if (firstKnown && unique.length === 2) {
    return t("stepLabels.etcSuffix", { label: t(toolActionLabelKeys[firstKnown]) });
  }
  return t("stepLabels.callCount", { count: unique.length });
}

function firstSummaryLine(text: string): string {
  const line = text.split("\n").find((segment) => segment.trim().length > 0) ?? "";
  return line
    .replace(/^[#>*\-\s]+/, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/`([^`]+)`/g, "$1")
    .trim();
}

function looksChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text);
}

function truncatePreview(text: string, max = SUMMARY_PREVIEW_MAX): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

function buildThoughtPreview(content: string): string | undefined {
  const line = firstSummaryLine(content);
  if (!line) return undefined;
  return truncatePreview(line);
}

/** Step card subtitle — prefer Chinese tool labels over English LLM body text. */
export function resolveStepSummaryText(
  input: {
    content: string;
    hasToolCalls: boolean;
    displayToolNames: string;
    toolActionLabel: string;
    isThought: boolean;
  },
  t: TranslateFn = enT,
): string {
  const thoughtPreview = buildThoughtPreview(input.content);
  const toolPart = input.hasToolCalls
    ? input.displayToolNames
      ? t("stepLabels.callNamed", { name: input.displayToolNames })
      : input.toolActionLabel
    : undefined;

  if (toolPart) {
    if (thoughtPreview) {
      if (
        thoughtPreview === toolPart ||
        thoughtPreview === input.toolActionLabel ||
        thoughtPreview === input.displayToolNames
      ) {
        return toolPart;
      }
      return `${thoughtPreview} · ${toolPart}`;
    }
    return toolPart;
  }

  if (input.isThought) {
    if (thoughtPreview && looksChinese(thoughtPreview)) {
      return thoughtPreview;
    }
    if (thoughtPreview) {
      return thoughtPreview;
    }
    return t("stepLabels.thinking");
  }
  if (thoughtPreview && looksChinese(thoughtPreview)) {
    return thoughtPreview;
  }
  return thoughtPreview ? t("stepLabels.thinking") : t("stepLabels.step");
}

export function resolveCollaborationCompletedStepLabel(
  toolNames: string[],
  linkedToolName?: string,
  t: TranslateFn = enT,
): string {
  const normalized = new Set(toolNames.map((name) => name.trim()).filter(Boolean));
  if (linkedToolName) normalized.add(linkedToolName);
  if (normalized.has("submit_plan")) return t("stepLabels.planApproved");
  if (normalized.has("ask_user")) return t("stepLabels.confirmationComplete");
  return t("stepLabels.collaborationComplete");
}

export function resolveCollaborationStepLabel(
  toolNames: string[],
  isActive: boolean,
  linkedToolName?: string,
  t: TranslateFn = enT,
): string {
  const normalized = new Set(toolNames.map((name) => name.trim()).filter(Boolean));
  if (linkedToolName) normalized.add(linkedToolName);
  if (normalized.has("submit_plan")) return t("stepLabels.planApproval");
  if (normalized.has("ask_user")) return isActive ? t("stepLabels.waitingUserChoice") : t("stepLabels.userCollaboration");
  return isActive ? t("stepLabels.ask_user") : t("stepLabels.collaborationStep");
}

export function resolveStepBadgePresentation({
  stepNumber,
  isFinalAnswer,
  isStreamingAnswer,
  isActive,
  isThought,
  isCollaboration,
  isWaitingForUser,
}: {
  stepNumber: number;
  isFinalAnswer: boolean;
  isStreamingAnswer: boolean;
  isActive: boolean;
  isThought?: boolean;
  isCollaboration?: boolean;
  isWaitingForUser?: boolean;
}):
  | { kind: "number"; value: number }
  | { kind: "waiting" }
  | { kind: "collaboration" }
  | { kind: "final" }
  | { kind: "streaming" }
  | { kind: "thought" }
  | { kind: "empty" } {
  if (stepNumber > 0) return { kind: "number", value: stepNumber };
  if (isWaitingForUser || (isCollaboration && isActive)) return { kind: "waiting" };
  if (isCollaboration) return { kind: "collaboration" };
  if (isFinalAnswer) return { kind: "final" };
  if (isStreamingAnswer) return { kind: "streaming" };
  if (isThought) return { kind: "thought" };
  return { kind: "empty" };
}
