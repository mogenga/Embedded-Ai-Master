import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadCorpusConfig } from "../src/config/corpus-config.js";
import type { CorpusConfig } from "../src/config/corpus-config.js";

/**
 * 配置层测试。
 *
 * **绝不碰真实 `$HARNESS_HOME`**：每个用例都拿 mkdtemp 造一个隔离根，把 home 与
 * resources 都指进临时目录。这里刻意不读 `process.env.HARNESS_HOME`——测试一旦
 * 依赖运行者的真实配置目录，用例结果就不再只由代码决定（`D-170` 的同类教训：
 * fixture 静默写进用户真实配置，事后只能靠文件内容反推来源）。
 */

const roots: string[] = [];

const VALID_PEM = "-----BEGIN PUBLIC KEY-----\nAAAA\n-----END PUBLIC KEY-----\n";

function validConfig(overrides: Partial<Record<keyof CorpusConfig, unknown>> = {}): Record<string, unknown> {
  return {
    version: 1,
    updateBaseUrl: "https://bucket.example/kb/",
    publicKeyPem: VALID_PEM,
    ...overrides,
  };
}

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), "corpus-config-"));
  roots.push(root);
  return root;
}

interface Layout {
  home: string;
  resources: string;
}

/** 造一对 home / resources 目录；传入的对象有值时才写文件，未传即「该级缺失」。 */
async function setup(files: {
  home?: Record<string, unknown> | string;
  resources?: Record<string, unknown> | string;
}): Promise<Layout> {
  const root = await tempRoot();
  const home = path.join(root, "home");
  const resources = path.join(root, "resources");
  await mkdir(home, { recursive: true });
  await mkdir(resources, { recursive: true });

  const write = async (dir: string, content: Record<string, unknown> | string): Promise<void> => {
    const text = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    await writeFile(path.join(dir, "corpus.json"), text, "utf8");
  };

  if (files.home !== undefined) await write(home, files.home);
  if (files.resources !== undefined) await write(resources, files.resources);
  return { home, resources };
}

afterEach(async () => {
  while (roots.length > 0) {
    const root = roots.pop();
    if (root !== undefined) {
      await rm(root, { recursive: true, force: true });
    }
  }
});

describe("loadCorpusConfig", () => {
  it("读取 home 级配置", async () => {
    const { home, resources } = await setup({ home: validConfig() });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result).toEqual({
      kind: "ok",
      source: "home",
      config: {
        version: 1,
        updateBaseUrl: "https://bucket.example/kb/",
        publicKeyPem: VALID_PEM,
      },
    });
  });

  it("home 缺失时读取 resources 级配置", async () => {
    const { home, resources } = await setup({ resources: validConfig() });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.source).toBe("resources");
    expect(result.config.updateBaseUrl).toBe("https://bucket.example/kb/");
  });

  it("两级都存在时 home 优先", async () => {
    const { home, resources } = await setup({
      home: validConfig({ updateBaseUrl: "https://home.example/kb/" }),
      resources: validConfig({ updateBaseUrl: "https://resources.example/kb/" }),
    });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.source).toBe("home");
    expect(result.config.updateBaseUrl).toBe("https://home.example/kb/");
  });

  it("home 级配置不合法时不回落到 resources 级", async () => {
    const { home, resources } = await setup({
      home: validConfig({ version: 2 }),
      resources: validConfig(),
    });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    // 静默降级会让用户以为改的是实际生效的那份配置（契约 §2 / R3）。
    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.source).toBe("home");
  });

  it("updateBaseUrl 不以 / 结尾时 invalid 且点名该字段", async () => {
    const { home, resources } = await setup({
      home: validConfig({ updateBaseUrl: "https://bucket.example/kb" }),
    });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.reason).toContain("updateBaseUrl");
    expect(result.reason).toContain("/");
    expect(result.source).toBe("home");
  });

  it("version 不是 1 时 invalid 且点名 version", async () => {
    const { home, resources } = await setup({ home: validConfig({ version: 2 }) });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.reason).toContain("version");
  });

  it("非 JSON 时 invalid 且 reason 提到解析失败", async () => {
    const { home, resources } = await setup({ home: "{ not json" });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.reason).toContain("解析");
  });

  it("带 UTF-8 BOM 的文件仍能读取", async () => {
    const { home, resources } = await setup({
      home: "\uFEFF" + JSON.stringify(validConfig(), null, 2),
    });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result).toEqual({
      kind: "ok",
      source: "home",
      config: {
        version: 1,
        updateBaseUrl: "https://bucket.example/kb/",
        publicKeyPem: VALID_PEM,
      },
    });
  });

  it("两级都不存在时返回 none", async () => {
    const { home, resources } = await setup({});

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result).toEqual({ kind: "none" });
  });

  it("未传 resourcesRoot 时只看 home 级", async () => {
    const { home } = await setup({});

    const result = await loadCorpusConfig({ harnessHome: home });

    expect(result).toEqual({ kind: "none" });
  });

  it("publicKeyPem 不是 PEM 时 invalid 且点名该字段", async () => {
    const { home, resources } = await setup({
      home: validConfig({ publicKeyPem: "not-a-key" }),
    });

    const result = await loadCorpusConfig({ harnessHome: home, resourcesRoot: resources });

    expect(result.kind).toBe("invalid");
    if (result.kind !== "invalid") return;
    expect(result.reason).toContain("publicKeyPem");
  });
});
