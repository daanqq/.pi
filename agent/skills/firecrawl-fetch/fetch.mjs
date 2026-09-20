#!/usr/bin/env node

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ENDPOINT = "https://api.firecrawl.dev/v2/scrape";
const TIMEOUT_MS = 60_000;
const MAX_OUTPUT_BYTES = 50 * 1024;
const MAX_OUTPUT_LINES = 2_000;

function fail(message) {
	console.error(`Error: ${message}`);
	process.exit(1);
}

function parsePublicUrl(value) {
	let url;
	try {
		url = new URL(value);
	} catch {
		fail("Usage: node fetch.mjs <https-url>");
	}

	if (url.protocol !== "https:") fail("Only public HTTPS URLs are supported.");
	if (url.username || url.password) fail("URLs containing credentials are not supported.");

	const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	if (
		hostname === "localhost" ||
		hostname === "::1" ||
		/^127\./.test(hostname) ||
		/^10\./.test(hostname) ||
		/^192\.168\./.test(hostname) ||
		/^169\.254\./.test(hostname) ||
		/^172\.(1[6-9]|2\d|3[01])\./.test(hostname)
	) {
		fail("Private and local URLs are not supported.");
	}

	return url.href;
}

function boundedOutput(text) {
	const lines = text.split("\n");
	let bytes = 0;
	let count = 0;

	for (; count < lines.length && count < MAX_OUTPUT_LINES; count++) {
		const lineBytes = Buffer.byteLength(lines[count], "utf8") + (count > 0 ? 1 : 0);
		if (bytes + lineBytes > MAX_OUTPUT_BYTES) break;
		bytes += lineBytes;
	}

	if (count === lines.length) return { text, truncated: false };
	return { text: lines.slice(0, count).join("\n"), truncated: true };
}

const input = process.argv[2];
if (!input || process.argv.length !== 3) fail("Usage: node fetch.mjs <https-url>");

const apiKey = process.env.FIRECRAWL_API_KEY?.trim();
if (!apiKey) fail("FIRECRAWL_API_KEY is not set.");

const url = parsePublicUrl(input);
let response;
try {
	response = await fetch(ENDPOINT, {
		method: "POST",
		headers: {
			Authorization: `Bearer ${apiKey}`,
			"Content-Type": "application/json",
		},
		body: JSON.stringify({ url, formats: ["markdown"] }),
		signal: AbortSignal.timeout(TIMEOUT_MS),
	});
} catch (error) {
	fail(error instanceof Error ? error.message : String(error));
}

let payload;
try {
	payload = await response.json();
} catch {
	fail(`Firecrawl returned a non-JSON response (HTTP ${response.status}).`);
}

if (!response.ok || payload?.success !== true) {
	const detail = typeof payload?.error === "string" ? payload.error : `HTTP ${response.status}`;
	fail(`Firecrawl scrape failed: ${detail}`);
}

const markdown = payload?.data?.markdown;
if (typeof markdown !== "string" || !markdown.trim()) fail("Firecrawl returned no Markdown content.");

const output = boundedOutput(markdown);
process.stdout.write(output.text);

if (output.truncated) {
	const directory = await mkdtemp(join(tmpdir(), "firecrawl-fetch-"));
	const outputPath = join(directory, "page.md");
	await writeFile(outputPath, markdown, { encoding: "utf8", mode: 0o600 });
	process.stdout.write(`\n\n[Output truncated at ${MAX_OUTPUT_LINES} lines or ${MAX_OUTPUT_BYTES} bytes. Full content saved to: ${outputPath}]\n`);
}
