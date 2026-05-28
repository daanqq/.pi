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
const SKILL_AUTOCOMPLETE_CONTEXT = /(?:^|[\s([{])\$[a-z0-9-]*$/;
const TRAILING_SKILL_TOKEN_WITH_SPACES = /(?:^|[\s([{])\$([a-z0-9-]*)\s*$/;
const LEADING_SKILL_INVOCATION = /^\s*\$([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\s+([\s\S]*))?$/;

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

function expandLeadingDollarSkill(text: string): { skillName: string; transformed: string } | undefined {
	const match = text.match(LEADING_SKILL_INVOCATION);
	const skillName = match?.[1];
	if (!skillName) return undefined;

	const args = match[2]?.trim();
	return {
		skillName,
		transformed: args ? `/skill:${skillName} ${args}` : `/skill:${skillName}`,
	};
}

export default function skillDollarExtension(pi: ExtensionAPI) {

	pi.on("session_start", (_event, ctx) => {
		if (!ctx.hasUI) return;
		ctx.ui.addAutocompleteProvider((current) => createSkillAutocompleteProvider(pi, current));
	});

	pi.on("input", async (event, ctx) => {
		const expansion = expandLeadingDollarSkill(event.text);
		if (!expansion) return { action: "continue" };

		const skill = getSkills(pi).find((skill) => skill.name === expansion.skillName);
		if (!skill) {
			ctx.ui.notify(`Unknown skill: $${expansion.skillName}`, "warning");
			return { action: "continue" };
		}

		return { action: "transform", text: expansion.transformed };
	});
}
