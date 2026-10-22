import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKbRoot, scanKbRoot } from "../../src/server/kb-locate.js";

/**
 * ESM 的命名空间对象不可 spy，权限注入只能靠模块 mock。
 *
 * `denyReaddir` 默认关闭：打开后只有这一个路径的 `readdir` 抛 EACCES，其余
 * 用例照常走真实 fs。真实 chmod 在 Windows 上不生效，也没有跨平台的
 * 「不可读目录」做法，mock 是唯一可复现的手段。
 */
let denyReaddir: string | undefined;

/** 同上，针对根定位用的同步 `statSync`：注入「路径存在但不可访问」。 */
let denyStatSync: string | undefined;

/** 同上，针对 `readFileSync`：注入「mcp.json 读不出来」。 */
let denyReadFileSync: string | undefined;

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const denied = (): never => {
    const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
    error.code = "EACCES";
    throw error;
  };
  return {
    ...actual,
    statSync: ((target: unknown, options?: unknown) => {
      if (denyStatSync !== undefined && String(target) === denyStatSync) denied();
      return actual.statSync(target as never, options as never);
    }) as typeof actual.statSync,
    readFileSync: ((target: unknown, options?: unknown) => {
      if (denyReadFileSync !== undefined && String(target) === denyReadFileSync) denied();
      return actual.readFileSync(target as never, options as never);
    }) as typeof actual.readFileSync,
  };
});

vi.mock("node:fs/promises", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...actual,
    readdir: (async (target: unknown, options?: unknown) => {
      if (denyReaddir !== undefined && String(target) === denyReaddir) {
        const error = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }
      return actual.readdir(target as never, options as never);
    }) as typeof actual.readdir,
  };
});

const tempDirs: string[] = [];

function tempDir(prefix = "eam-kb-locate-"): string {
  const dir = mkdtempSync(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function makeKb(root: string, files: Record<string, string> = {}): string {
  mkdirSync(root, { recursive: true });
  for (const [relative, content] of Object.entries(files)) {
    const full = path.join(root, relative);
    mkdirSync(path.dirname(full), { recursive: true });
    writeFileSync(full, content);
  }
  return root;
}

function writeMcpJson(home: string, document: unknown): void {
  mkdirSync(home, { recursive: true });
  writeFileSync(path.join(home, "mcp.json"), JSON.stringify(document));
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("resolveKbRoot: 优先级", () => {
  it("KB_ROOT 环境变量优先于 mcp.json 与默认目录", () => {
    const home = tempDir();
    const envRoot = makeKb(path.join(tempDir(), "from-env"));
    const mcpRoot = makeKb(path.join(tempDir(), "from-mcp"));
    writeMcpJson(home, {
      mcpServers: { kb: { command: "node", env: { KB_ROOT: mcpRoot } } },
    });
    const result = resolveKbRoot({
      harnessHome: home,
      repoRoot: tempDir(),
      env: { KB_ROOT: envRoot },
      cwd: tempDir(),
    });
    expect(result).toStrictEqual({
      root: envRoot,
      source: "env",
      note: "来自环境变量 KB_ROOT",
    });
  });

  it("相对 KB_ROOT 按 cwd 解析，source 仍是 env", () => {
    const base = tempDir();
    const result = resolveKbRoot({
      repoRoot: tempDir(),
      env: { KB_ROOT: "corpus/kb" },
      cwd: base,
    });
    expect(result.source).toBe("env");
    expect(result.root).toBe(path.join(base, "corpus", "kb"));
    // 目录不存在时也要保留候选，并说明原因。
    expect(result.note).toContain("目录不存在");
  });

  it("mcp.json 里任意一台带 KB_ROOT 的 server 都会被采用（优先 kb）", () => {
    const home = tempDir();
    const otherRoot = makeKb(path.join(tempDir(), "other"));
    const kbRoot = makeKb(path.join(tempDir(), "kb"));
    writeMcpJson(home, {
      mcpServers: {
        "probe-tools": { command: "node", env: { KB_ROOT: otherRoot } },
        kb: { command: "node", env: { KB_ROOT: kbRoot } },
      },
    });
    const result = resolveKbRoot({ harnessHome: home, repoRoot: tempDir(), env: {} });
    expect(result).toStrictEqual({
      root: kbRoot,
      source: "mcp.json",
      note: '来自 mcp.json 的 server "kb"',
    });
  });

  it("没有叫 kb 的 server 时取第一个带 KB_ROOT 的", () => {
    const home = tempDir();
    const only = makeKb(path.join(tempDir(), "only"));
    writeMcpJson(home, {
      mcpServers: { "domain-tools": { command: "node", env: { KB_ROOT: only } } },
    });
    const result = resolveKbRoot({ harnessHome: home, repoRoot: tempDir(), env: {} });
    expect(result.source).toBe("mcp.json");
    expect(result.root).toBe(only);
    expect(result.note).toContain("domain-tools");
  });

  it("相对 KB_ROOT 优先按 entry 的 cwd 解析", () => {
    const home = tempDir();
    const serverCwd = tempDir();
    writeMcpJson(home, {
      mcpServers: { kb: { command: "node", cwd: serverCwd, env: { KB_ROOT: "kb" } } },
    });
    const result = resolveKbRoot({
      harnessHome: home,
      repoRoot: tempDir(),
      env: {},
      cwd: tempDir(),
    });
    expect(result.source).toBe("mcp.json");
    expect(result.root).toBe(path.join(serverCwd, "kb"));
  });

  it("entry 没有 cwd 时相对 KB_ROOT 按进程 cwd 解析", () => {
    const home = tempDir();
    const processCwd = tempDir();
    writeMcpJson(home, {
      mcpServers: { kb: { command: "node", env: { KB_ROOT: "mcp-servers/kb/kb" } } },
    });
    const result = resolveKbRoot({ harnessHome: home, repoRoot: tempDir(), env: {}, cwd: processCwd });
    expect(result.source).toBe("mcp.json");
    expect(result.root).toBe(path.join(processCwd, "mcp-servers", "kb", "kb"));
  });

  it("没有 mcp.json 时回落到仓库默认目录", () => {
    const home = tempDir();
    const repoRoot = tempDir();
    const result = resolveKbRoot({ harnessHome: home, repoRoot, env: {} });
    expect(result.source).toBe("default");
    expect(result.root).toBe(path.join(repoRoot, "mcp-servers", "kb", "kb"));
    // 这个 fixture 里默认目录并不存在；候选仍要保留，note 说明为什么。
    expect(result.note).toContain("目录不存在");
  });

  it("默认目录存在时 note 只说明来源", () => {
    const repoRoot = tempDir();
    const root = makeKb(path.join(repoRoot, "mcp-servers", "kb", "kb"));
    const result = resolveKbRoot({ repoRoot, env: {} });
    expect(result).toStrictEqual({ root, source: "default", note: "使用仓库默认知识库目录" });
  });

  it("mcp.json 损坏时降级到默认目录且不抛", () => {
    const home = tempDir();
    writeFileSync(path.join(home, "mcp.json"), "{ 这不是 JSON");
    const repoRoot = tempDir();
    const result = resolveKbRoot({ harnessHome: home, repoRoot, env: {} });
    expect(result.source).toBe("default");
    expect(result.root).toBe(path.join(repoRoot, "mcp-servers", "kb", "kb"));
    // R3：降级要说明，不能静默当成「没配过」。
    expect(result.note).toContain("mcp.json 无法解析");
  });

  it("mcp.json 存在但读不出来时降级并说明，不抛", () => {
    const home = tempDir();
    const mcpPath = path.join(home, "mcp.json");
    writeFileSync(mcpPath, "{}");
    denyReadFileSync = mcpPath;
    try {
      const repoRoot = tempDir();
      const result = resolveKbRoot({ harnessHome: home, repoRoot, env: {} });
      expect(result.source).toBe("default");
      expect(result.note).toContain("mcp.json 读取失败");
    } finally {
      denyReadFileSync = undefined;
    }
  });

  it("mcp.json 的 mcpServers 不是对象时同样降级并说明", () => {
    const home = tempDir();
    writeMcpJson(home, { mcpServers: ["kb"] });
    const result = resolveKbRoot({ harnessHome: home, repoRoot: tempDir(), env: {} });
    expect(result.source).toBe("default");
    expect(result.note).toContain("mcpServers 不是对象");
  });

  it("连候选都算不出来时 root 为空且 source 为 none", () => {
    const home = tempDir();
    writeFileSync(path.join(home, "mcp.json"), "{ 坏");
    const result = resolveKbRoot({ harnessHome: home, repoRoot: "  ", env: {} });
    expect(result.root).toBe("");
    expect(result.source).toBe("none");
    expect(result.note).toContain("mcp.json 无法解析");
  });

  it("KB_ROOT 是空白时不当作显式覆盖", () => {
    const repoRoot = tempDir();
    const result = resolveKbRoot({ repoRoot, env: { KB_ROOT: "   " } });
    expect(result.source).toBe("default");
  });

  it("候选路径是文件而不是目录时如实说明，仍保留候选", () => {
    const base = tempDir();
    const file = path.join(base, "not-a-dir");
    writeFileSync(file, "x");
    const result = resolveKbRoot({ repoRoot: tempDir(), env: { KB_ROOT: file } });
    expect(result.root).toBe(file);
    expect(result.source).toBe("env");
    expect(result.note).toContain("不是目录");
  });

  it("候选路径存在但不可访问时 note 说明权限问题", () => {
    const base = tempDir();
    const denied = path.join(base, "denied");
    denyStatSync = denied;
    try {
      const result = resolveKbRoot({ repoRoot: tempDir(), env: { KB_ROOT: denied } });
      expect(result.root).toBe(denied);
      expect(result.source).toBe("env");
      expect(result.note).toContain("无法访问");
    } finally {
      denyStatSync = undefined;
    }
  });

  it("mcp.json 指向已删除的目录时保留候选并说明", () => {
    const home = tempDir();
    const gone = path.join(tempDir(), "gone");
    writeMcpJson(home, { mcpServers: { kb: { command: "node", env: { KB_ROOT: gone } } } });
    const result = resolveKbRoot({ harnessHome: home, repoRoot: tempDir(), env: {} });
    expect(result.root).toBe(path.resolve(gone));
    expect(result.source).toBe("mcp.json");
    expect(result.note).toContain("目录不存在");
  });
});

describe("scanKbRoot: 树与计数", () => {
  it("目录在前、按名排序，fileCount 只数 .md", async () => {
    const root = makeKb(tempDir(), {
      "index.yaml": "entries: []\n",
      "protocols/uart.md": "# uart\n",
      "protocols/spi.md": "# spi\n",
      "protocols/notes.txt": "not markdown\n",
      "debug/readme.MD": "# case-insensitive\n",
      "top.md": "# top\n",
    });
    const result = await scanKbRoot(root);
    expect(result.indexPresent).toBe(true);
    expect(result.truncated).toBe(false);
    expect(result.fileCount).toBe(4);
    expect(result.tree.map((node) => [node.name, node.kind])).toStrictEqual([
      ["debug", "dir"],
      ["protocols", "dir"],
      ["index.yaml", "file"],
      ["top.md", "file"],
    ]);
    const protocols = result.tree.find((node) => node.name === "protocols");
    expect(protocols?.children?.map((node) => node.name)).toStrictEqual([
      "notes.txt",
      "spi.md",
      "uart.md",
    ]);
  });

  it("index.yaml 是目录时不算存在", async () => {
    const root = makeKb(tempDir());
    mkdirSync(path.join(root, "index.yaml"));
    const result = await scanKbRoot(root);
    expect(result.indexPresent).toBe(false);
  });

  it("根不存在时回空树，不抛", async () => {
    const root = path.join(tempDir(), "missing");
    const result = await scanKbRoot(root);
    expect(result).toStrictEqual({ tree: [], fileCount: 0, indexPresent: false, truncated: false });
  });

  it("root 为空时不碰文件系统，回空结果", async () => {
    const result = await scanKbRoot("");
    expect(result).toStrictEqual({ tree: [], fileCount: 0, indexPresent: false, truncated: false });
  });

  it("条目触顶时 truncated 为真且树被截断", async () => {
    const root = makeKb(tempDir(), {
      "a.md": "# a\n",
      "b.md": "# b\n",
      "c.md": "# c\n",
    });
    const result = await scanKbRoot(root, { maxEntries: 2 });
    expect(result.truncated).toBe(true);
    expect(result.tree).toHaveLength(2);
  });

  it("文件数触顶时 truncated 为真，fileCount 只是下界", async () => {
    const root = makeKb(tempDir(), {
      "a.md": "# a\n",
      "b.md": "# b\n",
      "c.md": "# c\n",
    });
    const result = await scanKbRoot(root, { maxFiles: 2 });
    expect(result.truncated).toBe(true);
    // 宁可报「至少 2」，也不能报成精确的 3。
    expect(result.fileCount).toBe(2);
  });

  it("深度触顶时 truncated 为真", async () => {
    const root = makeKb(tempDir(), { "one/two/three/x.md": "# x\n" });
    const result = await scanKbRoot(root, { maxDepth: 2 });
    expect(result.truncated).toBe(true);
    expect(result.fileCount).toBe(0);
    const one = result.tree.find((node) => node.name === "one");
    expect(one?.children?.[0]?.children).toStrictEqual([]);
  });

  it("根是文件时回空树、不抛", async () => {
    const root = path.join(tempDir(), "plain.txt");
    writeFileSync(root, "x");
    const result = await scanKbRoot(root);
    expect(result).toStrictEqual({ tree: [], fileCount: 0, indexPresent: false, truncated: false });
  });

  it("根读不动（权限/IO）时抛错，交给端点报 error", async () => {
    const root = makeKb(tempDir(), { "a.md": "# a\n" });
    denyReaddir = root;
    try {
      await expect(scanKbRoot(root)).rejects.toThrow("EACCES");
    } finally {
      denyReaddir = undefined;
    }
  });

  it("子目录读不动时整棵树标记 truncated，而不是当作空目录", async () => {
    const root = makeKb(tempDir(), { "sub/a.md": "# a\n", "top.md": "# top\n" });
    denyReaddir = path.join(root, "sub");
    try {
      const result = await scanKbRoot(root);
      // 静默的空 children 会被读成「这个目录是空的」（R3）。
      expect(result.truncated).toBe(true);
      const sub = result.tree.find((node) => node.name === "sub");
      expect(sub?.children).toStrictEqual([]);
      // 根的读取本身没失败，所以不是异常。
      expect(result.fileCount).toBe(1);
    } finally {
      denyReaddir = undefined;
    }
  });
});
