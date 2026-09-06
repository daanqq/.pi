// Focused extension tests use the installed SDK implementations, without loading
// its unrelated experimental server barrel. No runtime implementation is mocked.
import { createRequire, registerHooks } from "node:module";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

const localRequire = createRequire(import.meta.url);
const sdkEntry = process.env.PI_TEST_SDK_DIR
  ? resolve(process.env.PI_TEST_SDK_DIR, "dist/index.js")
  : localRequire.resolve("@earendil-works/pi-coding-agent");
const sdk = new URL("./", pathToFileURL(sdkEntry));
const sdkRequire = createRequire(sdkEntry);
const exports = [
  ["CustomEditor", "modes/interactive/components/custom-editor.js"],
  ["renderDiff", "modes/interactive/components/diff.js"],
  ["keyHint", "modes/interactive/components/keybinding-hints.js"],
  ["withFileMutationQueue", "core/tools/file-mutation-queue.js"],
  ["VERSION", "config.js"],
  ["initTheme", "modes/interactive/theme/theme.js"],
].map(([name, path]) => `export { ${name} } from ${JSON.stringify(new URL(path, sdk).href)};`).join("\n");
const entry = `data:text/javascript;base64,${Buffer.from(exports).toString("base64")}`;
const dependencies = new Map(["@earendil-works/pi-tui", "typebox"].map((name) => [name, pathToFileURL(sdkRequire.resolve(name)).href]));
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "@earendil-works/pi-coding-agent") return { url: entry, shortCircuit: true };
    const dependency = dependencies.get(specifier);
    if (dependency) return { url: dependency, shortCircuit: true };
    return nextResolve(specifier, context);
  },
});
