import { basename } from "node:path";
import {
  createLocalBashOperations,
  type ExtensionAPI,
} from "@mariozechner/pi-coding-agent";

function shellQuote(value: string) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

function getZshPath() {
  if (process.env.PI_USER_BASH_SHELL) return process.env.PI_USER_BASH_SHELL;
  if (process.env.SHELL && basename(process.env.SHELL) === "zsh") {
    return process.env.SHELL;
  }
  return "/bin/zsh";
}

function getPiZshrcPath() {
  return process.env.PI_USER_ZSHRC ?? `${process.env.HOME}/.pi/agent/zshrc`;
}

export default function (pi: ExtensionAPI) {
  const local = createLocalBashOperations();

  pi.on("user_bash", () => {
    return {
      operations: {
        exec(command, cwd, options) {
          // Run zsh as a non-interactive shell. Avoid `-i`: it sources ~/.zshrc,
          // which can start prompt/ZLE integrations without a real interactive
          // job-control terminal. Source a small pi-specific zshrc instead for
          // safe aliases/functions, then eval the user command so aliases expand.
          const initPath = getPiZshrcPath();
          const initCommand = `[[ -r ${shellQuote(initPath)} ]] && source ${shellQuote(initPath)}; eval ${shellQuote(command)}`;
          const zshCommand = `PI_USER_BASH=1 exec ${shellQuote(getZshPath())} -fc ${shellQuote(initCommand)}`;
          return local.exec(zshCommand, cwd, options);
        },
      },
    };
  });
}