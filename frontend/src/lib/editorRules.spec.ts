import { describe, expect, it } from "vitest";
import {
  associationFor,
  defaultPatternFor,
  extensionOf,
  resolveEditorForFile,
  sanitizeEditorConfig,
  type EditorConfig,
  type KnownEditor,
} from "./editorRules";

function known(id: string, available = true): KnownEditor {
  return {
    id,
    name: id,
    available,
    launch: { kind: "openApp", appId: id },
    suggestedExtensions: [],
  };
}

const emptyConfig: EditorConfig = {
  associations: [],
  customEditors: [],
  uploadPolicy: "auto",
};

describe("extensionOf", () => {
  it("extracts multi-dot extensions lowercase", () => {
    expect(extensionOf("a.tar.gz")).toBe(".gz");
    expect(extensionOf("README.MD")).toBe(".md");
  });

  it("returns empty for dotfiles and extensionless names", () => {
    expect(extensionOf(".hidden")).toBe("");
    expect(extensionOf("Makefile")).toBe("");
    expect(extensionOf("")).toBe("");
  });
});

describe("associationFor", () => {
  it("matches extension patterns in all accepted forms", () => {
    const associations = [{ pattern: "*.log", editorId: "vscode" }];
    expect(associationFor("server.LOG", associations)?.editorId).toBe("vscode");
    expect(associationFor("a.log.gz", [{ pattern: ".log", editorId: "x" }])).toBeUndefined();
  });

  it("prefers exact filename over extension", () => {
    const associations = [
      { pattern: "*.conf", editorId: "vscode" },
      { pattern: "nginx.conf", customId: "c1" },
    ];
    expect(associationFor("nginx.conf", associations)?.customId).toBe("c1");
    expect(associationFor("other.conf", associations)?.editorId).toBe("vscode");
  });

  it("prefers the longer extension and breaks ties by order", () => {
    const associations = [
      { pattern: "*.gz", editorId: "short" },
      { pattern: "*.tar.gz", editorId: "long" },
    ];
    expect(associationFor("bundle.tar.gz", associations)?.editorId).toBe("long");
    expect(associationFor("log.gz", associations)?.editorId).toBe("short");
    const tie = [
      { pattern: "*.md", editorId: "first" },
      { pattern: ".md", editorId: "second" },
    ];
    expect(associationFor("a.md", tie)?.editorId).toBe("first");
  });

  it("ignores empty and garbage patterns", () => {
    expect(associationFor("a.txt", [{ pattern: "  ", editorId: "x" } as never])).toBeUndefined();
    expect(associationFor("a.txt", [{ pattern: "*.", editorId: "x" }])).toBeUndefined();
  });
});

describe("resolveEditorForFile", () => {
  const editors = [known("vscode"), known("gone", false)];

  it("falls back to system default when nothing matches", () => {
    expect(resolveEditorForFile("a.txt", emptyConfig, editors)).toEqual({ kind: "system" });
  });

  it("uses the association hit and skips unavailable known editors", () => {
    const config: EditorConfig = {
      ...emptyConfig,
      associations: [{ pattern: "*.go", editorId: "vscode" }],
    };
    expect(resolveEditorForFile("main.go", config, editors)).toEqual({
      kind: "known",
      editor: editors[0],
    });
    const broken: EditorConfig = {
      ...config,
      associations: [{ pattern: "*.go", editorId: "gone" }],
    };
    expect(resolveEditorForFile("main.go", broken, editors)).toEqual({ kind: "system" });
  });

  it("uses the default editor when no association matches", () => {
    const config: EditorConfig = { ...emptyConfig, defaultEditorId: "vscode" };
    expect(resolveEditorForFile("anything.txt", config, editors)).toEqual({
      kind: "known",
      editor: editors[0],
    });
    // 默认指向 unavailable 的 known 编辑器同样回落系统默认。
    expect(resolveEditorForFile("a.txt", { ...emptyConfig, defaultEditorId: "gone" }, editors)).toEqual({
      kind: "system",
    });
  });

  it("honors custom editors from associations before the default", () => {
    const custom = { id: "c1", name: "Mine", command: "code --wait {file}" };
    const config: EditorConfig = {
      defaultEditorId: "vscode",
      associations: [{ pattern: "*.docx", customId: "c1" }],
      customEditors: [custom],
      uploadPolicy: "auto",
    };
    expect(resolveEditorForFile("report.docx", config, editors)).toEqual({
      kind: "custom",
      editor: custom,
    });
    expect(resolveEditorForFile("note.txt", config, editors)).toEqual({
      kind: "known",
      editor: editors[0],
    });
  });
});

describe("sanitizeEditorConfig", () => {
  it("returns the default for non-object input", () => {
    expect(sanitizeEditorConfig(null)).toEqual(emptyConfig);
    expect(sanitizeEditorConfig("x")).toEqual(emptyConfig);
  });

  it("drops malformed entries and dangling custom references", () => {
    const sanitized = sanitizeEditorConfig({
      associations: [
        { pattern: "*.log", editorId: "vscode" },
        { pattern: "", editorId: "vscode" },
        { pattern: "*.x", customId: "missing" },
        { pattern: "*.y" },
        "garbage",
      ],
      customEditors: [
        { id: "c1", name: "", command: "code" },
        { id: "", command: "x" },
        { command: "no-id" },
        "garbage",
      ],
      defaultEditorId: "vscode",
      defaultCustomId: "missing",
      uploadPolicy: "ask",
      extra: "ignored",
    });
    expect(sanitized.associations).toEqual([{ pattern: "*.log", editorId: "vscode" }]);
    expect(sanitized.customEditors).toEqual([{ id: "c1", name: "c1", command: "code" }]);
    expect(sanitized.defaultEditorId).toBe("vscode");
    expect(sanitized.defaultCustomId).toBeUndefined();
    expect(sanitized.uploadPolicy).toBe("ask");
  });

  it("defaults the upload policy to auto", () => {
    expect(sanitizeEditorConfig({}).uploadPolicy).toBe("auto");
  });
});

describe("defaultPatternFor", () => {
  it("masks extensions and keeps exact names for extensionless files", () => {
    expect(defaultPatternFor("server.LOG")).toBe("*.log");
    expect(defaultPatternFor("archive.tar.gz")).toBe("*.gz");
    expect(defaultPatternFor("Makefile")).toBe("Makefile");
    expect(defaultPatternFor(".hidden")).toBe(".hidden");
  });
});
