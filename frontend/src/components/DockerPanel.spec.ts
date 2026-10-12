// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from "vitest";
import { flushPromises, mount } from "@vue/test-utils";
// @ts-expect-error — Node built-in types are not included in the frontend tsconfig.
import { spawnSync } from "node:child_process";
// @ts-expect-error — Same Node-only test dependency as above.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
// @ts-expect-error — Same Node-only test dependency as above.
import { platform, tmpdir } from "node:os";
// @ts-expect-error — Same Node-only test dependency as above.
import { join } from "node:path";
import DockerPanel from "./DockerPanel.vue";
import { DOCKER_ENGINE_STORE_KEY, saveDockerEngineSettings } from "../lib/dockerEngine";
import { pluginStore } from "../lib/pluginStore";

const directories: string[] = [];
const shells = ["bash", "zsh", "fish", "ash", "sh"];

afterEach(() => {
  for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
  pluginStore.removeItem(DOCKER_ENGINE_STORE_KEY);
  vi.unstubAllGlobals();
  document.body.innerHTML = "";
});

async function terminalCommand(cli = ""): Promise<string> {
  saveDockerEngineSettings("test-connection", { cli, socket: "", host: "" });
  // Only the external host bridge is replaced; use the real panel/menu/event path.
  vi.stubGlobal("dbxPlugin", {
    invoke: async (method: string) => {
      if (method === "ssh/sessions/list") {
        return { sessions: [{ sessionId: "test-session", connectionId: "test-connection", connected: true }] };
      }
      if (method === "docker/list") {
        return { available: true, containers: [{ id: "abc123", name: "test", state: "running" }] };
      }
      throw new Error(`Unexpected host call: ${method}`);
    },
  });
  const wrapper = mount(DockerPanel, { attachTo: document.body, props: { t: (key: string) => key } });
  let command = "";
  const capture = (event: Event) => { command = (event as CustomEvent<{ command: string }>).detail.command; };
  window.addEventListener("dbx:docker-open-in-terminal", capture);
  try {
    await flushPromises();
    await wrapper.get(".docker-row-trigger").trigger("click");
    await flushPromises();
    const button = Array.from(document.querySelectorAll<HTMLButtonElement>(".docker-row-menu-item"))
      .find((item) => item.textContent?.includes("docker.actionTerminal"));
    expect(button, "SSH container menu must offer a terminal action").toBeDefined();
    button!.click();
    expect(command, "terminal action must emit a command").not.toBe("");
    return command;
  } finally {
    window.removeEventListener("dbx:docker-open-in-terminal", capture);
    wrapper.unmount();
  }
}

function runCommand(command: string, availableShells: string[], exitCode: number, cli = "docker") {
  const directory = mkdtempSync(join(tmpdir(), "dbx-docker-shell-"));
  directories.push(directory);
  const executable = (name: string, body: string) =>
    writeFileSync(join(directory, name), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
  // Emulate the Docker boundary without a daemon/SSH connection. Run the exact
  // container script under a real POSIX shell with a controlled container PATH;
  // do not source the test machine's login profile via sh -l.
  executable(cli, `
if [ "$#" -ne 6 ] || [ "$1" != exec ] || [ "$2" != -it ] || [ "$3" != abc123 ] || [ "$4" != sh ] || [ "$5" != -lc ]; then
  exit 98
fi
exec /bin/sh -c "$6"`);
  for (const shell of availableShells) {
    executable(shell, `printf '%s\\n' '${shell}'\nexit ${exitCode}`);
  }
  return spawnSync("/bin/sh", ["-c", command], { env: { PATH: directory }, encoding: "utf8", timeout: 5_000 });
}

// Windows CI has no guaranteed POSIX /bin/sh; the real shell regression runs on
// macOS/Linux. The normal frontend typecheck still checks this file everywhere.
describe.skipIf(platform() === "win32")("Docker terminal shell selection (#182)", () => {
  it.each([0, 1, 127])("ends the session when Bash exits with status %i", async (exitCode) => {
    const result = runCommand(await terminalCommand(), shells, exitCode);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("bash\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(exitCode);
  });

  it.each(shells.slice(1))("selects %s when earlier shells are absent without missing-command noise", async (shell) => {
    const result = runCommand(await terminalCommand(), shells.slice(shells.indexOf(shell)), 127);
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe(`${shell}\n`);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(127);
  });

  it("uses the configured Podman CLI and preserves a nonzero shell exit", async () => {
    const result = runCommand(await terminalCommand("podman"), shells, 1, "podman");
    expect(result.error).toBeUndefined();
    expect(result.stdout).toBe("bash\n");
    expect(result.stderr).toBe("");
    expect(result.status).toBe(1);
  });
});
