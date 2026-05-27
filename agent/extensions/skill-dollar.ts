import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, SourceInfo } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	type AutocompleteProvider,
	type AutocompleteSuggestions,
	fuzzyFilter,
} from "@earendil-works/pi-tui";

type SkillInfo = {
	name: string;
	commandName: string;
	description?: string;
	sourceInfo: SourceInfo;
};

const MAX_SUGGESTIONS = 100;
const SKILL_TOKEN_BEFORE_CURSOR = /(?:^|[\s([{])\$([a-z0-9-]*)$/;
const SKILL_MARKER = /(?:^|[\s([{])\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)/g;
const SKILL_AUTOCOMPLETE_CONTEXT = /(?:^|[\s([{])\$[a-z0-9-]*$/;
const TRAILING_SKILL_TOKEN_WITH_SPACES = /(?:^|[\s([{])\$([a-z0-9-]*)\s*$/;

function getSkills(pi: ExtensionAPI): SkillInfo[] {
	return pi
		.getCommands()
		.filter((command) => command.source === "skill" && command.name.startsWith("skill:"))
		.map((command) => ({
			name: command.name.slice("skill:".length),
			commandName: command.name,
			description: command.description,
			sourceInfo: command.sourceInfo,
		}))
		.sort((a, b) => a.name.localeCompare(b.name));
}

function skillToAutocompleteItem(skill: SkillInfo): AutocompleteItem {
	return {
		value: `$${skill.name}`,
		label: `$${skill.name}`,
		description: skill.description,
	};
}

function filterSkills(skills: SkillInfo[], query: string): AutocompleteItem[] {
	if (!query.trim()) {
		return skills.slice(0, MAX_SUGGESTIONS).map(skillToAutocompleteItem);
	}

	const prefixMatches = skills
		.filter((skill) => skill.name.startsWith(query))
		.slice(0, MAX_SUGGESTIONS)
		.map(skillToAutocompleteItem);

	if (prefixMatches.length > 0) return prefixMatches;

	return fuzzyFilter(skills, query, (skill) => `${skill.name} ${skill.description ?? ""}`)
		.slice(0, MAX_SUGGESTIONS)
		.map(skillToAutocompleteItem);
}

function createSkillAutocompleteProvider(pi: ExtensionAPI, current: AutocompleteProvider): AutocompleteProvider {
	return {
		async getSuggestions(lines, cursorLine, cursorCol, options): Promise<AutocompleteSuggestions | null> {
			const currentLine = lines[cursorLine] ?? "";
			const beforeCursor = currentLine.slice(0, cursorCol);
			const match = beforeCursor.match(SKILL_TOKEN_BEFORE_CURSOR);
			const query = match?.[1];
			const skills = getSkills(pi);

			if (query === undefined) {
				const trailingSkillToken = beforeCursor.match(TRAILING_SKILL_TOKEN_WITH_SPACES);
				const completedQuery = trailingSkillToken?.[1];
				if (completedQuery !== undefined && !skills.some((skill) => skill.name === completedQuery)) return null;
				return current.getSuggestions(lines, cursorLine, cursorCol, options);
			}

			const exactSkill = skills.some((skill) => skill.name === query);
			if (exactSkill && !options.force) return null;

			const items = filterSkills(skills, query);
			if (options.signal.aborted || items.length === 0) return null;

			return {
				prefix: `$${query}`,
				items,
			};
		},

		applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
			if (!prefix.startsWith("$")) {
				return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
			}

			const currentLine = lines[cursorLine] ?? "";
			const beforePrefix = currentLine.slice(0, cursorCol - prefix.length);
			const afterCursor = currentLine.slice(cursorCol);
			const suffix = afterCursor.startsWith(" ") || afterCursor.startsWith("\t") ? "" : " ";
			const newLine = `${beforePrefix}${item.value}${suffix}${afterCursor}`;
			const newLines = [...lines];
			newLines[cursorLine] = newLine;

			return {
				lines: newLines,
				cursorLine,
				cursorCol: beforePrefix.length + item.value.length + suffix.length,
			};
		},

		shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
			const currentLine = lines[cursorLine] ?? "";
			const beforeCursor = currentLine.slice(0, cursorCol);
			if (SKILL_AUTOCOMPLETE_CONTEXT.test(beforeCursor)) return true;

			const trailingSkillToken = beforeCursor.match(TRAILING_SKILL_TOKEN_WITH_SPACES);
			const query = trailingSkillToken?.[1];
			if (query !== undefined && !getSkills(pi).some((skill) => skill.name === query)) return false;

			return current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ?? true;
		},
	};
}

function extractRequestedSkillNames(prompt: string): string[] {
	const names = new Set<string>();
	for (const match of prompt.matchAll(SKILL_MARKER)) {
		const name = match[1];
		if (name) names.add(name);
	}
	return [...names];
}

function resolveSkillMarkdownPath(sourceInfo: SourceInfo): string | undefined {
	const sourcePath = sourceInfo.path;
	if (!sourcePath || !existsSync(sourcePath)) return undefined;

	const stat = statSync(sourcePath);
	if (stat.isFile()) return sourcePath;
	if (!stat.isDirectory()) return undefined;

	const skillMd = join(sourcePath, "SKILL.md");
	return existsSync(skillMd) ? skillMd : undefined;
}

function readSkillContent(skill: SkillInfo, cache: Map<string, string>): string | undefined {
	const skillPath = resolveSkillMarkdownPath(skill.sourceInfo);
	if (!skillPath) return undefined;

	const cached = cache.get(skillPath);
	if (cached !== undefined) return cached;

	const content = readFileSync(skillPath, "utf-8");
	cache.set(skillPath, content);
	return content;
}

function buildSkillPromptBlock(selectedSkills: Array<{ skill: SkillInfo; content: string }>): string {
	const sections = selectedSkills.map(
		({ skill, content }) => `### $${skill.name}\n\nSource: ${skill.sourceInfo.path}\n\n${content.trim()}`,
	);

	return [
		"## User-selected skills for this turn",
		"",
		"The user explicitly selected these skills via `$skill-name` inline syntax.",
		"Load and follow the selected skill instructions for this turn.",
		"Treat `$skill-name` markers as skill-selection syntax, not as part of the task content.",
		"",
		...sections,
	].join("\n");
}

export default function skillDollarExtension(pi: ExtensionAPI) {
	const skillContentCache = new Map<string, string>();

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(pi, current));
	});

	pi.on("before_agent_start", async (event, ctx) => {
		const requestedNames = extractRequestedSkillNames(event.prompt);
		if (requestedNames.length === 0) return undefined;

		const skillsByName = new Map(getSkills(pi).map((skill) => [skill.name, skill]));
		const selectedSkills: Array<{ skill: SkillInfo; content: string }> = [];

		for (const name of requestedNames) {
			const skill = skillsByName.get(name);
			if (!skill) {
				ctx.ui.notify(`Unknown skill: $${name}`, "warning");
				continue;
			}

			try {
				const content = readSkillContent(skill, skillContentCache);
				if (!content) {
					ctx.ui.notify(`Could not load skill: $${name}`, "warning");
					continue;
				}
				selectedSkills.push({ skill, content });
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				ctx.ui.notify(`Could not load skill $${name}: ${message}`, "warning");
			}
		}

		if (selectedSkills.length === 0) return undefined;

		ctx.ui.notify(`Using skills: ${selectedSkills.map(({ skill }) => `$${skill.name}`).join(", ")}`, "info");

		return {
			systemPrompt: `${event.systemPrompt}\n\n${buildSkillPromptBlock(selectedSkills)}`,
		};
	});
}
