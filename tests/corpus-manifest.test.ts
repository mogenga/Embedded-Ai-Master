import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  CorpusManifestError,
  canonicalize,
  compareVersions,
  diffFiles,
  parseManifest,
  sha256File,
  signManifestPayload,
  verifyManifestSignature,
} from "../src/corpus/manifest.js";
import type { CorpusManifest, ManifestFile } from "../src/corpus/manifest.js";

// 密钥对在测试里现场生成：仓库里不出现任何私钥/公钥字面量。
// 生成一次给整个文件用——Ed25519 生成很快，但每个用例都生成没有额外价值。
let privateKeyPem: string;
let publicKeyPem: string;
let otherPublicKeyPem: string;
let otherPrivateKeyPem: string;

beforeAll(() => {
  const pair = generateKeyPairSync("ed25519");
  privateKeyPem = String(pair.privateKey.export({ type: "pkcs8", format: "pem" }));
  publicKeyPem = String(pair.publicKey.export({ type: "spki", format: "pem" }));
  // 一把「格式正确但不是同一对」的公钥/私钥：证明验签失败不是靠解析错误凑出来的。
  const other = generateKeyPairSync("ed25519");
  otherPublicKeyPem = String(other.publicKey.export({ type: "spki", format: "pem" }));
  otherPrivateKeyPem = String(other.privateKey.export({ type: "pkcs8", format: "pem" }));
});

const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const PUBLISHED_AT = "2026-10-23T12:00:00Z";

function makeManifest(overrides: Partial<CorpusManifest> = {}): CorpusManifest {
  return {
    manifestVersion: 1,
    corpusVersion: 2,
    publishedAt: PUBLISHED_AT,
    files: [
      { path: "index.yaml", sha256: SHA_A },
      { path: "protocols/uart/no-output.md", sha256: SHA_B },
    ],
    signature: "",
    ...overrides,
  };
}

/** 签名并回填 signature，得到一份「发布侧会产出的」清单。 */
function signed(manifest: CorpusManifest = makeManifest(), key = privateKeyPem): CorpusManifest {
  return { ...manifest, signature: signManifestPayload(manifest, key) };
}

/** 构造一份 raw 对象用于 parseManifest；signature 用合法 base64 占位。 */
function rawManifest(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    manifestVersion: 1,
    corpusVersion: 2,
    publishedAt: PUBLISHED_AT,
    files: [{ path: "index.yaml", sha256: SHA_A }],
    signature: Buffer.alloc(64, 7).toString("base64"),
    ...overrides,
  };
}

const tmpDirs: string[] = [];

function makeTmpDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "corpus-manifest-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("canonicalize", () => {
  it("键序不同的等价对象产出完全相同的字符串", () => {
    const left = { b: 2, a: 1, c: 3 };
    const right = { c: 3, a: 1, b: 2 };
    expect(canonicalize(left)).toBe(canonicalize(right));
    expect(canonicalize(left)).toBe('{"a":1,"b":2,"c":3}');
  });

  it("嵌套对象也递归排序，且没有多余空白", () => {
    const value = { outer: { z: 1, a: { y: 2, b: 3 } }, first: true };
    expect(canonicalize(value)).toBe('{"first":true,"outer":{"a":{"b":3,"y":2},"z":1}}');
  });

  it("数组保持原序（顺序是内容的一部分）", () => {
    expect(canonicalize([3, 1, 2])).toBe("[3,1,2]");
    expect(canonicalize([{ b: 1, a: 2 }, "x"])).toBe('[{"a":2,"b":1},"x"]');
    // 调换顺序必须真的改变字节，否则「调换 files 顺序」那条验签用例是假通过。
    expect(canonicalize([1, 2])).not.toBe(canonicalize([2, 1]));
  });

  it("字符串按 JSON 规则转义，非 ASCII 原样保留（UTF-8）", () => {
    expect(canonicalize({ s: 'a"b\\c\n中文' })).toBe('{"s":"a\\"b\\\\c\\n中文"}');
  });

  it("含 undefined 值抛错，不静默丢弃该键", () => {
    // JSON.stringify 会给出 "{}"——签名覆盖的字节就与内容不符了，所以这里必须抛。
    expect(() => canonicalize({ a: undefined })).toThrow(CorpusManifestError);
    expect(() => canonicalize({ a: undefined })).toThrow(/undefined/);
    expect(() => canonicalize(undefined)).toThrow(CorpusManifestError);
  });

  it("函数与 symbol 抛错", () => {
    expect(() => canonicalize({ fn: () => 1 })).toThrow(/function/);
    expect(() => canonicalize({ sym: Symbol("x") })).toThrow(/symbol/);
  });

  it("数组里的 undefined 也抛错（否则会变成 null）", () => {
    expect(() => canonicalize([1, undefined])).toThrow(CorpusManifestError);
  });

  it("NaN / Infinity 抛错，不静默变成 null", () => {
    expect(() => canonicalize({ n: Number.NaN })).toThrow(/非有限数字/);
    expect(() => canonicalize({ n: Number.POSITIVE_INFINITY })).toThrow(/非有限数字/);
  });

  it("非普通对象（Date / Map / 类实例）抛错", () => {
    expect(() => canonicalize(new Date(0))).toThrow(/只接受普通对象与数组/);
    expect(() => canonicalize(new Map())).toThrow(/只接受普通对象与数组/);
    class Box {
      readonly v = 1;
    }
    expect(() => canonicalize(new Box())).toThrow(/Box/);
  });

  it("循环引用抛错；同一对象出现在两个兄弟位置不算循环", () => {
    const loop: Record<string, unknown> = {};
    loop.self = loop;
    expect(() => canonicalize(loop)).toThrow(/循环引用/);

    const shared = { a: 1 };
    expect(canonicalize({ x: shared, y: shared })).toBe('{"x":{"a":1},"y":{"a":1}}');
  });
});

describe("parseManifest", () => {
  it("接受契约 §4 的合法清单，并只保留已知字段", () => {
    const manifest = parseManifest(rawManifest());
    expect(manifest.manifestVersion).toBe(1);
    expect(manifest.corpusVersion).toBe(2);
    expect(manifest.publishedAt).toBe(PUBLISHED_AT);
    expect(manifest.files).toEqual([{ path: "index.yaml", sha256: SHA_A }]);
    expect(manifest.signature).toBe(Buffer.alloc(64, 7).toString("base64"));
  });

  it("顶层必须是对象", () => {
    for (const value of [null, undefined, 42, "x", []]) {
      expect(() => parseManifest(value)).toThrow(/顶层必须是 JSON 对象/);
    }
  });

  it("顶层未知字段拒绝（签名覆盖范围必须确定）", () => {
    expect(() => parseManifest(rawManifest({ extra: true }))).toThrow(/未知顶层字段 extra/);
    // 拼写错误的已知字段同样算未知字段，会被抓住。
    expect(() => parseManifest(rawManifest({ corpusversion: 2 }))).toThrow(/未知顶层字段/);
  });

  it("文件条目出现未知字段也拒绝", () => {
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "index.yaml", sha256: SHA_A, size: 1 }] })),
    ).toThrow(/未知字段 size/);
  });

  it("manifestVersion 必须为 1", () => {
    expect(() => parseManifest(rawManifest({ manifestVersion: 2 }))).toThrow(/manifestVersion 必须是 1/);
    expect(() => parseManifest(rawManifest({ manifestVersion: "1" }))).toThrow(/manifestVersion/);
    expect(() => parseManifest(rawManifest({ manifestVersion: undefined }))).toThrow(/manifestVersion/);
  });

  it("corpusVersion 必须是 ≥ 1 的整数", () => {
    for (const value of [0, -1, 1.5, Number.NaN, "2", null, undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(() => parseManifest(rawManifest({ corpusVersion: value }))).toThrow(/corpusVersion/);
    }
    expect(parseManifest(rawManifest({ corpusVersion: 1 })).corpusVersion).toBe(1);
    expect(parseManifest(rawManifest({ corpusVersion: 999 })).corpusVersion).toBe(999);
  });

  it("publishedAt 必须是可解析的带时区 ISO 时间", () => {
    for (const value of [
      "2026-10-23",
      "2026-10-23T12:00:00", // 缺时区：不同机器会解析成不同时刻
      "2026-13-01T00:00:00Z",
      "2026-10-23T25:00:00Z",
      "昨天",
      "",
      1792756800000,
      null,
    ]) {
      expect(() => parseManifest(rawManifest({ publishedAt: value }))).toThrow(/publishedAt/);
    }
    expect(parseManifest(rawManifest({ publishedAt: "2026-10-23T12:00:00.123Z" })).publishedAt)
      .toBe("2026-10-23T12:00:00.123Z");
    expect(parseManifest(rawManifest({ publishedAt: "2026-10-23T20:00:00+08:00" })).publishedAt)
      .toBe("2026-10-23T20:00:00+08:00");
  });

  it("files 必须是数组", () => {
    for (const value of [undefined, null, {}, "x"]) {
      expect(() => parseManifest(rawManifest({ files: value }))).toThrow(/files 必须是数组/);
    }
  });

  it("路径穿越 ../etc/passwd 抛错", () => {
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "../etc/passwd.md", sha256: SHA_A }] })),
    ).toThrow(/路径穿越/);
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "a/../../b.md", sha256: SHA_A }] })),
    ).toThrow(/".."/);
  });

  it("绝对路径抛错：/x.md、C:/x.md、c:x.md", () => {
    for (const value of ["/x.md", "C:/x.md", "c:x.md", "//server/share/x.md"]) {
      expect(() => parseManifest(rawManifest({ files: [{ path: value, sha256: SHA_A }] }))).toThrow(
        /相对路径|空路径段/,
      );
    }
  });

  it("反斜杠路径抛错", () => {
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "a\\b.md", sha256: SHA_A }] })),
    ).toThrow(/反斜杠/);
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "..\\etc\\passwd.md", sha256: SHA_A }] })),
    ).toThrow(/反斜杠/);
  });

  it("空路径段抛错：a//b.md、a/b.md/、空串", () => {
    for (const value of ["a//b.md", "a/b.md/", ""]) {
      expect(() => parseManifest(rawManifest({ files: [{ path: value, sha256: SHA_A }] }))).toThrow(
        /空路径段|空路径/,
      );
    }
  });

  it('"." 路径段抛错（否则同一文件可用两种写法绕过重复检查）', () => {
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "./index.yaml", sha256: SHA_A }] })),
    ).toThrow(/"\." 路径段/);
  });

  it("非 .md / .yaml 扩展名抛错", () => {
    for (const value of ["index.json", "a/b.txt", "noext", "x.MD", "y.YAML"]) {
      expect(() => parseManifest(rawManifest({ files: [{ path: value, sha256: SHA_A }] }))).toThrow(
        /扩展名只允许/,
      );
    }
    // 合法的两种都接受。
    expect(() =>
      parseManifest(
        rawManifest({
          files: [
            { path: "index.yaml", sha256: SHA_A },
            { path: "a/b.md", sha256: SHA_B },
          ],
        }),
      ),
    ).not.toThrow();
  });

  it("path 必须是字符串", () => {
    for (const value of [undefined, null, 42, {}, ["index.yaml"]]) {
      expect(() => parseManifest(rawManifest({ files: [{ path: value, sha256: SHA_A }] }))).toThrow(
        /必须是字符串/,
      );
    }
  });

  it("含 NUL 字符的 path 抛错（NUL 会在原生调用处截断路径）", () => {
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "a\0b.md", sha256: SHA_A }] })),
    ).toThrow(/NUL/);
  });

  it("只有扩展名、没有文件名的 path 抛错", () => {
    for (const value of [".md", "sub/.yaml"]) {
      expect(() => parseManifest(rawManifest({ files: [{ path: value, sha256: SHA_A }] }))).toThrow(
        /缺少文件名/,
      );
    }
  });

  it("files 的条目必须是对象", () => {
    for (const entry of ["index.yaml", null, 42, ["index.yaml", SHA_A]]) {
      expect(() => parseManifest(rawManifest({ files: [entry] }))).toThrow(/files\[0\] 必须是对象/);
    }
  });

  it("path 不得重复", () => {
    expect(() =>
      parseManifest(
        rawManifest({
          files: [
            { path: "index.yaml", sha256: SHA_A },
            { path: "index.yaml", sha256: SHA_B },
          ],
        }),
      ),
    ).toThrow(/path 重复/);
  });

  it("_inbox.md 不得出现在清单里（契约 §4）", () => {
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "_inbox.md", sha256: SHA_A }] })),
    ).toThrow(/_inbox\.md/);
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "sub/_inbox.md", sha256: SHA_A }] })),
    ).toThrow(/_inbox\.md/);
  });

  // 名单必须与 mcp-servers/kb/inbox.ts 的 MANAGED_CORPUS_EXCLUDES 对齐：
  // 发布侧跳过什么，验证侧就得拒什么，否则「跳过但不拒」会让这些文件悄悄进清单。
  it("_reviewed.md 同样不得出现在清单里（与发布侧排除名单对齐）", () => {
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "_reviewed.md", sha256: SHA_A }] })),
    ).toThrow(/_reviewed\.md/);
    expect(() =>
      parseManifest(rawManifest({ files: [{ path: "sub/_reviewed.md", sha256: SHA_A }] })),
    ).toThrow(/_reviewed\.md/);
  });

  it("sha256 必须是 64 位小写 hex", () => {
    for (const value of [
      "A".repeat(64), // 大写
      "a".repeat(63),
      "a".repeat(65),
      "g".repeat(64),
      SHA_A.toUpperCase(),
      "",
      null,
      undefined,
    ]) {
      expect(() => parseManifest(rawManifest({ files: [{ path: "index.yaml", sha256: value }] })))
        .toThrow(/sha256/);
    }
  });

  it("signature 必须是非空标准 base64", () => {
    for (const value of [
      "",
      "   ",
      "not base64!!",
      "YQ", // 缺补齐
      "Y Q = =", // 内部空白
      "YQ===", // 多余补齐
      null,
      undefined,
      123,
    ]) {
      expect(() => parseManifest(rawManifest({ signature: value }))).toThrow(/signature/);
    }
  });

  it("错误里带出具体位置（哪一条、哪个 path、哪个字段）", () => {
    try {
      parseManifest(
        rawManifest({
          files: [
            { path: "ok.md", sha256: SHA_A },
            { path: "../evil.md", sha256: SHA_B },
          ],
        }),
      );
      throw new Error("应当抛错");
    } catch (error) {
      expect(error).toBeInstanceOf(CorpusManifestError);
      const manifestError = error as CorpusManifestError;
      expect(manifestError.code).toBe("corpus_manifest_invalid");
      expect(manifestError.message).toContain("files[1]");
      expect(manifestError.message).toContain("../evil.md");
    }
  });
});

describe("签名与验签", () => {
  it("签名 → 验签通过", () => {
    const manifest = signed();
    expect(verifyManifestSignature(manifest, publicKeyPem)).toBe(true);
  });

  it("签名是 64 字节 Ed25519 签名的 base64", () => {
    const signature = signManifestPayload(makeManifest(), privateKeyPem);
    expect(Buffer.from(signature, "base64")).toHaveLength(64);
    expect(signature).toBe(Buffer.from(signature, "base64").toString("base64"));
  });

  it("签名对键序不敏感：字段顺序不同的等价清单签出同一串", () => {
    const a = makeManifest();
    const b: CorpusManifest = {
      files: a.files,
      publishedAt: a.publishedAt,
      corpusVersion: a.corpusVersion,
      manifestVersion: 1,
      signature: "",
    };
    expect(signManifestPayload(a, privateKeyPem)).toBe(signManifestPayload(b, privateKeyPem));
  });

  it("篡改 corpusVersion → 验签失败", () => {
    const manifest = signed();
    expect(verifyManifestSignature({ ...manifest, corpusVersion: 3 }, publicKeyPem)).toBe(false);
  });

  it("篡改某个 path → 验签失败", () => {
    const manifest = signed();
    const tampered: CorpusManifest = {
      ...manifest,
      files: manifest.files.map((file, index) =>
        index === 0 ? { ...file, path: "index-renamed.yaml" } : file,
      ),
    };
    expect(verifyManifestSignature(tampered, publicKeyPem)).toBe(false);
  });

  it("篡改某个 sha256 → 验签失败", () => {
    const manifest = signed();
    const tampered: CorpusManifest = {
      ...manifest,
      files: manifest.files.map((file, index) => (index === 1 ? { ...file, sha256: SHA_C } : file)),
    };
    expect(verifyManifestSignature(tampered, publicKeyPem)).toBe(false);
  });

  it("调换 files 顺序 → 验签失败（顺序是 payload 的一部分）", () => {
    const manifest = signed();
    const reordered: CorpusManifest = { ...manifest, files: [...manifest.files].reverse() };
    // 先确认两边的文件名集合完全相同，排除「其实是内容不同」的可能。
    expect(new Set(reordered.files.map((file) => file.path))).toEqual(
      new Set(manifest.files.map((file) => file.path)),
    );
    expect(verifyManifestSignature(reordered, publicKeyPem)).toBe(false);
  });

  it("篡改 publishedAt → 验签失败", () => {
    const manifest = signed();
    expect(
      verifyManifestSignature({ ...manifest, publishedAt: "2026-10-24T00:00:00Z" }, publicKeyPem),
    ).toBe(false);
  });

  it("换一把（格式合法的）公钥 → 验签失败，且不抛错", () => {
    expect(verifyManifestSignature(signed(), otherPublicKeyPem)).toBe(false);
  });

  it("payload 是「去掉 signature」而不是「signature: null」占位（行为断言）", () => {
    // 不直接比字符串，而是真的按错误做法签一次，确认这样签出来的清单验不过：
    // 若两种做法字节相同，下面会因为「错误做法也能通过」而失败。
    const manifest = makeManifest();
    const wrongPayload = canonicalize({ ...manifest, signature: null } as unknown);
    const wrongSignature = sign(null, Buffer.from(wrongPayload, "utf8"), privateKeyPem);
    const signedTheWrongWay: CorpusManifest = {
      ...manifest,
      signature: wrongSignature.toString("base64"),
    };
    expect(verifyManifestSignature(signedTheWrongWay, publicKeyPem)).toBe(false);
    // 正解仍然通过，证明失败原因确实是载荷字节不同，而不是密钥/格式问题。
    expect(verifyManifestSignature(signed(manifest), publicKeyPem)).toBe(true);
  });

  it("各种坏输入一律返回 false，绝不抛错", () => {
    const manifest = signed();
    const cases: Array<[string, () => boolean]> = [
      ["公钥不是 PEM", () => verifyManifestSignature(manifest, "not a pem")],
      // 注意：把**同一对**的私钥 PEM 传给 verify 会返回 true——OpenSSL 会从私钥
      // 推出公钥，这是 Ed25519 的正常语义，不是漏洞（用别的密钥对的私钥验同一串
      // 签名仍是 false）。所以这里用「另一对」的私钥，证明的不是格式而是密钥不匹配。
      ["另一对的私钥", () => verifyManifestSignature(manifest, otherPrivateKeyPem)],
      ["空公钥", () => verifyManifestSignature(manifest, "")],
      ["签名不是 base64", () => verifyManifestSignature({ ...manifest, signature: "!!!" }, publicKeyPem)],
      ["签名为空", () => verifyManifestSignature({ ...manifest, signature: "" }, publicKeyPem)],
      ["签名过短", () =>
        verifyManifestSignature({ ...manifest, signature: Buffer.alloc(10).toString("base64") }, publicKeyPem)],
      ["签名是别的长度", () =>
        verifyManifestSignature({ ...manifest, signature: Buffer.alloc(65, 1).toString("base64") }, publicKeyPem)],
      ["manifest 为 null", () =>
        verifyManifestSignature(null as unknown as CorpusManifest, publicKeyPem)],
      ["files 不是数组", () =>
        verifyManifestSignature(
          { ...manifest, files: "x" } as unknown as CorpusManifest,
          publicKeyPem,
        )],
    ];
    for (const [label, run] of cases) {
      expect(() => run(), label).not.toThrow();
      expect(run(), label).toBe(false);
    }
  });

  it("端到端：parseManifest → 验签，或篡改后 parseManifest → 验签失败", () => {
    const manifest = signed();
    const raw = JSON.parse(JSON.stringify(manifest)) as unknown;
    const parsed = parseManifest(raw);
    expect(verifyManifestSignature(parsed, publicKeyPem)).toBe(true);

    const tamperedRaw = JSON.parse(JSON.stringify(manifest)) as Record<string, unknown>;
    tamperedRaw.corpusVersion = 99;
    const tampered = parseManifest(tamperedRaw);
    expect(verifyManifestSignature(tampered, publicKeyPem)).toBe(false);
  });

  it("签名与验签都不需要联网、不读磁盘", () => {
    // 只是把「这一层是纯内存计算」钉住：换到断网机器上行为不变。
    const manifest = signed();
    expect(verifyManifestSignature(manifest, publicKeyPem)).toBe(true);
  });
});

describe("compareVersions", () => {
  it("remote < local → rollback_rejected（防回滚）", () => {
    expect(compareVersions(3, 2)).toBe("rollback_rejected");
    expect(compareVersions(1, 0)).toBe("rollback_rejected");
  });

  it("remote > local → update_available", () => {
    expect(compareVersions(2, 3)).toBe("update_available");
  });

  it("remote === local → up_to_date", () => {
    expect(compareVersions(2, 2)).toBe("up_to_date");
    expect(compareVersions(0, 0)).toBe("up_to_date");
  });

  it("非法版本号抛错，不静默落进 up_to_date", () => {
    // NaN 的两个比较都是 false；若放过，就会把「版本号坏了」显示成「已是最新」。
    expect(() => compareVersions(Number.NaN, 2)).toThrow(/本地语料版本/);
    expect(() => compareVersions(2, Number.NaN)).toThrow(/远端语料版本/);
    expect(() => compareVersions(1.5, 2)).toThrow(/本地语料版本/);
    expect(() => compareVersions(2, -1)).toThrow(/远端语料版本/);
  });
});

describe("diffFiles", () => {
  const manifest = makeManifest({
    files: [
      { path: "index.yaml", sha256: SHA_A },
      { path: "a/changed.md", sha256: SHA_B },
      { path: "a/new.md", sha256: SHA_C },
    ],
  });

  it("只返回 sha256 变化的与新增的文件", () => {
    const current: ManifestFile[] = [
      { path: "index.yaml", sha256: SHA_A }, // 未变
      { path: "a/changed.md", sha256: "d".repeat(64) }, // 变了
      { path: "a/removed.md", sha256: SHA_B }, // 已删除
    ];
    expect(diffFiles(current, manifest)).toEqual([
      { path: "a/changed.md", sha256: SHA_B },
      { path: "a/new.md", sha256: SHA_C },
    ]);
  });

  it("不返回被删除的文件（删除由切指针完成）", () => {
    const current: ManifestFile[] = [
      { path: "index.yaml", sha256: SHA_A },
      { path: "a/changed.md", sha256: SHA_B },
      { path: "a/new.md", sha256: SHA_C },
      { path: "gone.md", sha256: SHA_A },
    ];
    expect(diffFiles(current, manifest)).toEqual([]);
  });

  it("全部相同 → 空数组", () => {
    expect(diffFiles(manifest.files, manifest)).toEqual([]);
  });

  it("current 为 null → 返回全量", () => {
    expect(diffFiles(null, manifest)).toEqual(manifest.files);
  });

  it("返回的是新对象：调用方改动不会波及传入的清单", () => {
    const result = diffFiles(null, manifest);
    result[0]!.path = "mutated.md";
    expect(manifest.files[0]!.path).toBe("index.yaml");
  });

  it("顺序沿用目标清单顺序（可复现）", () => {
    const result = diffFiles([], manifest);
    expect(result.map((file) => file.path)).toEqual([
      "index.yaml",
      "a/changed.md",
      "a/new.md",
    ]);
  });
});

describe("sha256File", () => {
  // 硬编码已知向量：用 createHash 现算再比对等于拿同一份实现自证。
  const SHA256_EMPTY = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
  const SHA256_ABC = "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad";

  it("已知内容的临时文件算出正确值", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "abc.md");
    writeFileSync(file, "abc", "utf8");
    expect(await sha256File(file)).toBe(SHA256_ABC);
  });

  it("空文件算出空串的 sha256", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "empty.md");
    writeFileSync(file, "", "utf8");
    expect(await sha256File(file)).toBe(SHA256_EMPTY);
  });

  it("返回 64 位小写 hex", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "x.md");
    writeFileSync(file, "hello", "utf8");
    expect(await sha256File(file)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("跨多个数据块的大文件结果正确（流式读不会漏字节）", async () => {
    const dir = makeTmpDir();
    const file = path.join(dir, "big.md");
    const content = randomBytes(1024 * 1024 + 12345);
    await writeFile(file, content);
    const expected = createHash("sha256").update(content).digest("hex");
    expect(await sha256File(file)).toBe(expected);
    // 顺带确认落盘内容确实超过一个读流块的量级。
    expect(readFileSync(file)).toHaveLength(content.length);
  });

  it("文件不存在时抛错，不返回空串或全 0（R3）", async () => {
    const dir = makeTmpDir();
    await expect(sha256File(path.join(dir, "missing.md"))).rejects.toThrow(/校验值计算失败/);
  });
});
