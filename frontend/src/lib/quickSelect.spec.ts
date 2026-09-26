// Quick Select 纯逻辑单测（WT-1，对标 WezTerm Quick Select）：
// 四类正则抽取与尾部修剪、八位组校验、包含过滤与去重、容量上限（行长/行数/命中数）、
// 折行拼接与行列定位、viewport/buffer 两种档位、坏数据降级（缺行/零行不抛）。
// 全程注入 Buffer-like 假实现，不触碰真实 xterm。
import { describe, expect, it } from "vitest";
import { collectQuickSelectHits, QUICK_SELECT_DEFAULT_LIMITS, type QuickSelectBufferLike } from "./quickSelect";

interface FakeLine {
  text: string;
  wrapped?: boolean;
}

function fakeBuffer(lines: Array<string | FakeLine>, viewportY = 0): QuickSelectBufferLike {
  const normalized = lines.map((line) => (typeof line === "string" ? { text: line } : line));
  return {
    length: normalized.length,
    viewportY,
    getLine(row: number) {
      const line = normalized[row];
      if (!line) return undefined;
      return {
        isWrapped: line.wrapped ?? false,
        translateToString: () => line.text,
      };
    },
  };
}

function scan(lines: Array<string | FakeLine>, viewportRows = lines.length, options = {}) {
  const normalized = lines.map((line) => (typeof line === "string" ? { text: line } : line));
  return collectQuickSelectHits(fakeBuffer(normalized), viewportRows, options);
}

describe("URL 抽取", () => {
  it("命中 http/https/ftp 并修剪尾部标点", () => {
    const hits = scan(["see https://example.com/a?b=1&c=2 now"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("url");
    expect(hits[0].text).toBe("https://example.com/a?b=1&c=2");
    expect(hits[0].col).toBe(4);

    const punctuated = scan(["open https://example.com/x.,;:!?"]);
    expect(punctuated[0].text).toBe("https://example.com/x");

    const parenthesized = scan(["(see http://example.com/x)"]);
    expect(parenthesized[0].text).toBe("http://example.com/x");

    const ftp = scan(["mirror ftp://files.example.org/pub/"]);
    expect(ftp[0].kind).toBe("url");
  });

  it("配对括号保留在 URL 内，未配对右括号视为外层文本", () => {
    const balanced = scan(["wiki https://example.com/wiki/Foo_(bar) page"]);
    expect(balanced[0].text).toBe("https://example.com/wiki/Foo_(bar)");
  });

  it("不含 scheme 的文本不误报", () => {
    expect(scan(["plain text and two words"])).toHaveLength(0);
  });
});

describe("IPv4 抽取", () => {
  it("命中合法地址并做 0..255 校验", () => {
    const hits = scan(["ping 10.0.0.1 and 256.300.1.2 and 192.168.1.255"]);
    expect(hits.map((hit) => hit.text)).toEqual(["10.0.0.1", "192.168.1.255"]);
    expect(hits.every((hit) => hit.kind === "ipv4")).toBe(true);
  });

  it("端口后缀不吞：10.0.0.1:8080 只取地址", () => {
    expect(scan(["ssh admin@10.0.0.1:8082"])[0].text).toBe("10.0.0.1");
  });
});

describe("路径抽取", () => {
  it("命中绝对路径与 ~ / ./ 前缀", () => {
    const hits = scan(["tail -f /var/log/nginx/error.log and cat ~/.zshrc ./build/out.js"]);
    expect(hits.map((hit) => hit.text)).toEqual(["/var/log/nginx/error.log", "~/.zshrc", "./build/out.js"]);
    expect(hits[0].kind).toBe("path");
  });

  it("裸 / 与裸 ~ 不算路径，尾部句点修剪", () => {
    const hits = scan(["cd / . ~ ls /tmp/dir."]);
    expect(hits.map((hit) => hit.text)).toEqual(["/tmp/dir"]);
  });
});

describe("hash 抽取", () => {
  it("命中 7..64 位十六进制，纯数字与过短串不算", () => {
    const hits = scan(["commit deadbeef ok abc123 short 1234567 digits abcdef0"]);
    expect(hits.map((hit) => hit.text)).toEqual(["deadbeef", "abcdef0"]);
    expect(hits.every((hit) => hit.kind === "hash")).toBe(true);
  });

  it("大小写混合与 64 位 SHA-256 上界", () => {
    const sha256 = "ABCDEF0123456789abcdef0123456789ABCDEF0123456789abcdef0123456789";
    expect(scan([`sha256 ${sha256}`])[0].text).toBe(sha256);
    // 65 位起整体不再是 git SHA/摘要：\b 边界在 {7,64} 的任何截断处都不成立，
    // 整段不命中（比吐出误导性的前缀片段更安全），也不抛不崩。
    expect(scan([`long ${sha256}0`])).toHaveLength(0);
  });
});

describe("包含过滤与去重", () => {
  it("URL 内的 IPv4/hash 不重复报，路径内的 hash 归路径", () => {
    const hits = scan(["visit https://10.0.0.1/deadbeef/path here"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].kind).toBe("url");
    expect(hits[0].text).toBe("https://10.0.0.1/deadbeef/path");

    const layered = scan(["/var/lib/docker/overlay2/deadbeef01/diff"]);
    expect(layered).toHaveLength(1);
    expect(layered[0].kind).toBe("path");
  });

  it("同一文本跨行去重，首个胜出", () => {
    const hits = scan(["open https://example.com/x", "again https://example.com/x"]);
    expect(hits).toHaveLength(1);
    expect(hits[0].row).toBe(0);
  });
});

describe("折行拼接与定位", () => {
  it("isWrapped 链拼接成逻辑行，跨行 URL 完整且定位到起始行列", () => {
    const hits = scan([
      { text: "docs at https://example.com/very/long" },
      { text: "/path/continuation end", wrapped: true },
    ]);
    expect(hits).toHaveLength(1);
    expect(hits[0].text).toBe("https://example.com/very/long/path/continuation");
    expect(hits[0].row).toBe(0);
    expect(hits[0].col).toBe(8);
  });

  it("非折行行各自独立抽取", () => {
    const hits = scan(["https://a.example/one", "https://b.example/two"]);
    expect(hits.map((hit) => hit.row)).toEqual([0, 1]);
  });
});

describe("档位与容量上限", () => {
  it("viewport 只扫可视区，buffer 档从可视区底向上扩展", () => {
    const lines = Array.from({ length: 10 }, (_, index) => `marker-${index} https://${index}.example/x`);
    const viewportY = 6;
    const viewportHits = collectQuickSelectHits(fakeBuffer(lines, viewportY), 3);
    expect(viewportHits.map((hit) => hit.row)).toEqual([6, 7, 8]);

    const bufferHits = collectQuickSelectHits(fakeBuffer(lines, viewportY), 3, { scope: "buffer" });
    expect(bufferHits.length).toBeGreaterThan(3);
    expect(bufferHits[0].row).toBe(0);
  });

  it("maxHits 截断、maxLineChars 截断后不再抽取但不抛", () => {
    const noisy = scan(["https://1.example/a https://2.example/a https://3.example/a"], 1, { limits: { maxHits: 2 } });
    expect(noisy).toHaveLength(2);

    const long = "x".repeat(200) + " https://tail.example/a";
    const capped = scan([long], 1, { limits: { maxLineChars: 100 } });
    expect(capped).toHaveLength(0);
  });

  it("默认上限为常量表所载值", () => {
    expect(QUICK_SELECT_DEFAULT_LIMITS).toEqual({ maxRows: 2048, maxLineChars: 8192, maxHits: 200 });
  });
});

describe("坏数据降级", () => {
  it("空缓冲、零行、缺行、超界 viewportY 都安全返回", () => {
    expect(collectQuickSelectHits(fakeBuffer([]), 10)).toEqual([]);
    expect(collectQuickSelectHits(fakeBuffer([{ text: "https://a.example/x" }]), 0)).toHaveLength(1);
    // 稀疏行（getLine 返回 undefined）跳过不抛。
    const sparse: QuickSelectBufferLike = {
      length: 3,
      viewportY: 0,
      getLine: (row: number) => (row === 1 ? { isWrapped: false, translateToString: () => "https://b.example/y" } : undefined),
    };
    const hits = collectQuickSelectHits(sparse, 3);
    expect(hits).toHaveLength(1);
    expect(hits[0].row).toBe(1);
  });

  it("超长敌意行在默认上限内线性扫描完成（超截断点的尾部丢弃）", () => {
    const hits = scan(["a".repeat(100) + " https://deep.example/b " + "a".repeat(50_000)], 1);
    expect(hits[0].text).toBe("https://deep.example/b");
    expect(scan(["a".repeat(50_000) + " https://beyond.example/z"], 1)).toHaveLength(0);
  });
});
