import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_DOCKER_CLI,
  DOCKER_ENGINE_STORE_KEY,
  dockerEngineParams,
  EMPTY_DOCKER_ENGINE_SETTINGS,
  loadDockerEngineSettings,
  saveDockerEngineSettings,
  validateDockerEngineSettings,
} from "./dockerEngine";
import { pluginStore } from "./pluginStore";

describe("validateDockerEngineSettings", () => {
  it("trims input and keeps empty cli legal (default docker)", () => {
    const { settings, errors } = validateDockerEngineSettings({ cli: "  ", socket: "", host: "" });
    expect(settings).toEqual({ cli: "", socket: "", host: "" });
    expect(errors).toEqual({});
    expect(DEFAULT_DOCKER_CLI).toBe("docker");
  });

  it("accepts podman names, full paths and both endpoint shapes", () => {
    expect(validateDockerEngineSettings({ cli: "podman", socket: "", host: "" }).errors).toEqual({});
    expect(
      validateDockerEngineSettings({ cli: "/usr/local/bin/podman", socket: "/run/user/1000/podman.sock", host: "" })
        .errors,
    ).toEqual({});
    expect(validateDockerEngineSettings({ cli: "", socket: "", host: "127.0.0.1:2375" }).errors).toEqual({});
  });

  it("rejects shell metacharacters in cli", () => {
    const { errors } = validateDockerEngineSettings({ cli: "docker; rm -rf /", socket: "", host: "" });
    expect(errors.cli).toBe("invalid");
  });

  it("rejects malformed endpoints", () => {
    expect(validateDockerEngineSettings({ cli: "", socket: "unix:///a b.sock", host: "" }).errors.endpoints).toBe(
      "invalid",
    );
    expect(validateDockerEngineSettings({ cli: "", socket: "", host: "no-port-here" }).errors.endpoints).toBe(
      "invalid",
    );
  });

  it("enforces socket/host exclusivity", () => {
    const { errors } = validateDockerEngineSettings({
      cli: "",
      socket: "/run/podman.sock",
      host: "127.0.0.1:2375",
    });
    expect(errors.endpoints).toBe("conflict");
  });
});

describe("dockerEngineParams", () => {
  it("drops empty fields so legacy calls stay untouched", () => {
    expect(dockerEngineParams({ cli: "", socket: "", host: "" })).toEqual({});
    expect(dockerEngineParams({ cli: "podman", socket: "", host: "" })).toEqual({ cli: "podman" });
    expect(dockerEngineParams({ cli: "podman", socket: "/run/podman.sock", host: "" })).toEqual({
      cli: "podman",
      socket: "/run/podman.sock",
    });
  });
});

describe("pluginStore persistence", () => {
  beforeEach(() => {
    // node 环境无宿主桥/localStorage → pluginStore 为内存通道；模块级单例
    // 需要逐用例清键隔离。
    pluginStore.removeItem(DOCKER_ENGINE_STORE_KEY);
  });

  it("stores per-connection settings under the single structured key", () => {
    expect(DOCKER_ENGINE_STORE_KEY).toBe("ssh-docker-engine");
    saveDockerEngineSettings("conn-1", { cli: "podman", socket: "", host: "" });
    const map = JSON.parse(pluginStore.getItem(DOCKER_ENGINE_STORE_KEY)!);
    expect(map["conn-1"]).toEqual({ cli: "podman", socket: "", host: "" });
    expect(saveDockerEngineSettings("", { cli: "", socket: "/run/podman.sock", host: "" })).toBeUndefined();
    expect(Object.keys(JSON.parse(pluginStore.getItem(DOCKER_ENGINE_STORE_KEY)!))).toEqual(["conn-1", "local"]);
  });

  it("round-trips saved settings and validates on load", () => {
    saveDockerEngineSettings("conn-1", { cli: "podman", socket: "", host: "127.0.0.1:2375" });
    expect(loadDockerEngineSettings("conn-1")).toEqual({ cli: "podman", socket: "", host: "127.0.0.1:2375" });
    // 损坏 JSON 整份回落空映射；非法字段在读取侧同样被过滤。
    pluginStore.setItem(DOCKER_ENGINE_STORE_KEY, "{not json");
    expect(loadDockerEngineSettings("conn-1")).toEqual(EMPTY_DOCKER_ENGINE_SETTINGS);
    pluginStore.setItem(
      DOCKER_ENGINE_STORE_KEY,
      JSON.stringify({
        evil: { cli: 42, socket: "/ok.sock", host: "evil; host" },
      }),
    );
    // socket/host 同时存在触发互斥校验：两者一并剔除（无法判定保谁）。
    expect(loadDockerEngineSettings("evil")).toEqual({ cli: "", socket: "", host: "" });
  });

  it("falls back to empty settings for unknown connections", () => {
    expect(loadDockerEngineSettings("never-saved")).toEqual(EMPTY_DOCKER_ENGINE_SETTINGS);
  });
});
