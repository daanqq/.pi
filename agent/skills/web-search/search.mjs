#!/usr/bin/env node

const DEFAULT_MODEL = "gpt-6-luna";
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_CLIPROXY_BASE_URL = "http://127.0.0.1:8317/backend-api";

function parseArgs(argv) {
	const args = { model: DEFAULT_MODEL, purpose: "general research support", timeoutMs: DEFAULT_TIMEOUT_MS, json: false, query: "" };
	const positional = [];
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === "--help" || arg === "-h") args.help = true;
		else if (arg === "--json") args.json = true;
		else if (arg === "--model") args.model = argv[++i] || DEFAULT_MODEL;
		else if (arg.startsWith("--model=")) args.model = arg.slice(8) || DEFAULT_MODEL;
		else if (arg === "--purpose") args.purpose = argv[++i] || args.purpose;
		else if (arg.startsWith("--purpose=")) args.purpose = arg.slice(10) || args.purpose;
		else if (arg === "--timeout") args.timeoutMs = Math.max(1000, Number(argv[++i] || DEFAULT_TIMEOUT_MS));
		else if (arg.startsWith("--timeout=")) args.timeoutMs = Math.max(1000, Number(arg.slice(10) || DEFAULT_TIMEOUT_MS));
		else positional.push(arg);
	}
	args.query = positional.join(" ").trim();
	return args;
}

function usage() {
	return `Usage:\n  node search.mjs "<query>" [--purpose "<why>"] [--model <id>] [--json]`;
}

function resolveApiKey() {
	const apiKey = process.env.CLIPROXY_API_KEY;
	if (!apiKey) throw new Error("CLIPROXY_API_KEY не задан.");
	return apiKey;
}

function prompt(query, purpose) {
	return `Search the internet for: ${query}\n\nPurpose: ${purpose}\n\nReturn a concise research summary with:\n- 3 to 7 key findings\n- for every finding: title, why it matters for this purpose, and a full canonical URL (https://...)\n- if multiple sources disagree, call that out\n- finish with a short recommendation on which source(s) to trust first.`;
}

function eventData(chunk) {
	const data = chunk.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trim()).join("\n").trim();
	return data && data !== "[DONE]" ? data : undefined;
}

async function search({ model, apiKey, query, purpose, timeoutMs }) {
	const baseUrl = process.env.CLIPROXY_BASE_URL || DEFAULT_CLIPROXY_BASE_URL;
	const response = await fetch(`${baseUrl.replace(/\/$/, "")}/codex/responses`, {
		method: "POST",
		headers: {
			"X-Api-Key": apiKey,
			"content-type": "application/json",
			accept: "text/event-stream",
		},
		body: JSON.stringify({
			model,
			store: false,
			stream: true,
			instructions: "You are a fast web research assistant. Always produce practical summaries and include full source URLs (no shortened links).",
			input: [{ role: "user", content: prompt(query, purpose) }],
			tools: [{ type: "web_search" }],
			tool_choice: "auto",
		}),
		signal: AbortSignal.timeout(timeoutMs),
	});
	if (!response.ok || !response.body) throw new Error(`Codex request failed (${response.status}): ${await response.text()}`);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	let fallback = "";
	while (true) {
		const { done, value } = await reader.read();
		if (done) break;
		buffer += decoder.decode(value, { stream: true });
		let index;
		while ((index = buffer.indexOf("\n\n")) !== -1) {
			const data = eventData(buffer.slice(0, index));
			buffer = buffer.slice(index + 2);
			if (!data) continue;
			let event;
			try { event = JSON.parse(data); } catch { continue; }
			if (event.type === "response.output_text.delta") text += event.delta || "";
			if (event.type === "response.output_item.done" && event.item?.type === "message") {
				fallback = (event.item.content || []).filter((part) => part.type === "output_text").map((part) => part.text).join("\n");
			}
			if (event.type === "error" || event.type === "response.failed") throw new Error(event.message || event.response?.error?.message || "Codex stream failed");
		}
	}
	const result = (text || fallback).trim();
	if (!result) throw new Error("Codex вернул пустой ответ.");
	return result;
}

async function main() {
	const args = parseArgs(process.argv.slice(2));
	if (args.help || !args.query) {
		console.error(usage());
		process.exit(args.help ? 0 : 1);
	}
	const result = await search({ model: args.model, apiKey: resolveApiKey(), query: args.query, purpose: args.purpose, timeoutMs: args.timeoutMs });
	if (args.json) console.log(JSON.stringify({ provider: "openai-codex", model: args.model, query: args.query, purpose: args.purpose, result }, null, 2));
	else console.log(`Provider: openai-codex\nModel: ${args.model}\n\n${result}`);
}

main().catch((error) => {
	console.error(`Error: ${error?.message || error}`);
	process.exit(1);
});
