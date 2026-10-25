import { describe, expect, it } from "vitest";
import {
  DEFAULT_TIMESTAMP_SERVER,
  SignPreflightError,
  assessCertificate,
  buildSigningCommand,
  describeCert,
  extractCommonName,
  findSigntool,
  isLocalMachineStore,
  looksLikeModulePathProblem,
  normalizeCertList,
  parseArgs,
  parsePowerShellDate,
  resolvePowershell,
  selectSigningCert,
  storeNameOf,
  summarize,
  type CertificateRecord,
  type DescribedCert,
} from "../scripts/sign-preflight.mjs";

/**
 * `scripts/sign-preflight.mjs` 的测试。
 *
 * **不调 PowerShell、不读证书存储、不触网**：查询证书与探测时间戳都依赖这台机器
 * 装了什么东西，那与「匹配规则 / 判断规则对不对」是两件事，混在一起会让测试随机器变红。
 * 纯函数用注入的数据断言；`findSigntool` / `resolvePowershell` 用 `platform` 参数
 * 走非 Windows 分支，断言「不猜、不抛、如实返回无法检查」。
 *
 * 依据是 electron-builder 26.15.3 的 `windowsSignToolManager.js`：
 * `getCertificateFromStoreInfo` 用 `Subject.includes(subjectName)` 与
 * `Thumbprint.toUpperCase() === sha1.toUpperCase()` 匹配，`computedPublisherName`
 * 用 `parseDn(subject).get("CN")` 取发布者名。这些规则写错了，本脚本就会
 * 「说能签」而实际签不上，或者反过来。
 */

const NOW = Date.UTC(2026, 9, 25, 12, 0, 0);

function record(overrides: Partial<CertificateRecord> = {}): CertificateRecord {
  return {
    Subject: "CN=Embedded AI Master, O=Mogenga, C=CN",
    PSParentPath: "Microsoft.PowerShell.Security\\Certificate::CurrentUser\\My",
    Thumbprint: "aabbccddeeff00112233445566778899aabbccdd",
    HasPrivateKey: true,
    NotAfter: "/Date(1814304000000)/",
    ...overrides,
  };
}

function described(overrides: Partial<CertificateRecord> = {}): DescribedCert {
  return describeCert(record(overrides), NOW);
}

describe("normalizeCertList", () => {
  it("空输出 → 空数组（没有证书不是解析失败）", () => {
    expect(normalizeCertList("")).toEqual([]);
    expect(normalizeCertList("   \n ")).toEqual([]);
  });

  it("单张证书：ConvertTo-Json 输出的是对象而不是数组，要接住", () => {
    const list = normalizeCertList(JSON.stringify({ Subject: "CN=a" }));
    expect(list).toHaveLength(1);
    expect(list[0].Subject).toBe("CN=a");
  });

  it("多张证书：数组原样返回", () => {
    const list = normalizeCertList(JSON.stringify([{ Subject: "CN=a" }, { Subject: "CN=b" }]));
    expect(list.map((item) => item.Subject)).toEqual(["CN=a", "CN=b"]);
  });

  it("输出不是 JSON → 抛 SignPreflightError，不静默当空", () => {
    expect(() => normalizeCertList("not json")).toThrow(SignPreflightError);
  });
});

describe("parsePowerShellDate", () => {
  it("/Date(ms)/ 形态", () => {
    expect(parsePowerShellDate("/Date(1814304000000)/")).toBe(1814304000000);
  });

  it("/Date(ms+0800)/ 带时区偏移的形态", () => {
    expect(parsePowerShellDate("/Date(1814304000000+0800)/")).toBe(1814304000000);
  });

  it("ISO 字符串形态", () => {
    expect(parsePowerShellDate("2027-06-01T00:00:00Z")).toBe(Date.UTC(2027, 5, 1));
  });

  it("认不出 → null（不猜成过期或不过期）", () => {
    expect(parsePowerShellDate("下周二")).toBeNull();
    expect(parsePowerShellDate(null)).toBeNull();
    expect(parsePowerShellDate(12345)).toBeNull();
  });
});

describe("extractCommonName", () => {
  it("取 CN", () => {
    expect(extractCommonName("CN=Embedded AI Master, O=Mogenga, C=CN")).toBe("Embedded AI Master");
  });

  it("CN 不在第一位", () => {
    expect(extractCommonName("O=Mogenga, CN=Embedded AI Master, C=CN")).toBe("Embedded AI Master");
  });

  it("CN 的值被引号包住、内部含逗号", () => {
    expect(extractCommonName('CN="Embedded, Inc.", O=X')).toBe("Embedded, Inc.");
  });

  it("没有 CN → null（app-update.yml 会写不出 publisherName）", () => {
    expect(extractCommonName("O=Mogenga, C=CN")).toBeNull();
    expect(extractCommonName("")).toBeNull();
  });

  it("CN= 但值为空 → null", () => {
    expect(extractCommonName("CN=, O=X")).toBeNull();
  });
});

describe("describeCert", () => {
  it("指纹统一大写（与 electron-builder 的比较一致）", () => {
    expect(described().thumbprint).toBe("AABBCCDDEEFF00112233445566778899AABBCCDD");
  });

  it("存储名取 PSParentPath 最后一段", () => {
    expect(described().store).toBe("My");
    expect(
      described({
        PSParentPath: "Microsoft.PowerShell.Security\\Certificate::LocalMachine\\Root",
      }).store,
    ).toBe("Root");
  });

  it("LocalMachine 存储要加 /sm", () => {
    expect(
      isLocalMachineStore("Microsoft.PowerShell.Security\\Certificate::LocalMachine\\My"),
    ).toBe(true);
    expect(isLocalMachineStore("Microsoft.PowerShell.Security\\Certificate::CurrentUser\\My")).toBe(
      false,
    );
  });

  it("过期判断按注入的 now 算", () => {
    const cert = describeCert(record({ NotAfter: "/Date(1000)/" }), NOW);
    expect(cert.expired).toBe(true);
  });

  it("时间认不出时 expired 是 null，不是 false", () => {
    const cert = describeCert(record({ NotAfter: "下周二" }), NOW);
    expect(cert.expired).toBeNull();
  });

  it("HasPrivateKey 非 true 一律当没有", () => {
    expect(describeCert(record({ HasPrivateKey: false }), NOW).hasPrivateKey).toBe(false);
    expect(describeCert(record({ HasPrivateKey: null }), NOW).hasPrivateKey).toBe(false);
    expect(describeCert(record({ HasPrivateKey: undefined }), NOW).hasPrivateKey).toBe(false);
  });
});

describe("selectSigningCert", () => {
  it("两个选择器都不给 → no-selector（electron-builder 不会自动挑证书）", () => {
    const selection = selectSigningCert([described()], {});
    expect(selection.kind).toBe("no-selector");
  });

  it("subjectName 是子串匹配（不是全等）", () => {
    const selection = selectSigningCert([described()], { subjectName: "Embedded AI Master" });
    expect(selection.kind).toBe("selected");
  });

  it("subjectName 大小写敏感（Subject.includes 的行为）", () => {
    const selection = selectSigningCert([described()], { subjectName: "embedded ai master" });
    expect(selection.kind).toBe("not-found");
  });

  it("sha1 忽略大小写且要全等", () => {
    const certs = [described()];
    expect(selectSigningCert(certs, { sha1: "AABBCCDDEEFF00112233445566778899AABBCCDD" }).kind).toBe(
      "selected",
    );
    expect(selectSigningCert(certs, { sha1: "aabbccddeeff00112233445566778899aabbccdd" }).kind).toBe(
      "selected",
    );
    // 前缀不算命中——这是与 subjectName 的关键区别
    expect(selectSigningCert(certs, { sha1: "AABBCC" }).kind).toBe("not-found");
  });

  it("两个选择器同时给时取交集", () => {
    const certs = [described(), described({ Thumbprint: "1111", Subject: "CN=Other, O=X" })];
    expect(selectSigningCert(certs, { subjectName: "Other", sha1: "1111" }).kind).toBe("selected");
    expect(selectSigningCert(certs, { subjectName: "Embedded", sha1: "1111" }).kind).toBe(
      "not-found",
    );
  });

  it("命中多张 → ambiguous（同名证书续期后新旧并存）", () => {
    const certs = [
      described({ Thumbprint: "1111" }),
      described({ Thumbprint: "2222" }),
    ];
    const selection = selectSigningCert(certs, { subjectName: "Embedded AI Master" });
    expect(selection.kind).toBe("ambiguous");
  });

  it("空选择串等同于没给", () => {
    expect(selectSigningCert([described()], { subjectName: "", sha1: "" }).kind).toBe(
      "no-selector",
    );
  });
});

describe("assessCertificate", () => {
  it("有私钥 + 未过期 + 在 My 存储 → 可以签", () => {
    expect(assessCertificate(described(), NOW).ok).toBe(true);
  });

  it("没有私钥 → 不能签，且说清原因（令牌没插）", () => {
    const result = assessCertificate(described({ HasPrivateKey: false }), NOW);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("私钥");
  });

  it("已过期 → 不能签", () => {
    const result = assessCertificate(described({ NotAfter: "/Date(1000)/" }), NOW);
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("过期");
  });

  it("不在 My 存储 → 不能签（/s 会用它，但不是常规做法）", () => {
    const result = assessCertificate(
      described({ PSParentPath: "Microsoft.PowerShell.Security\\Certificate::CurrentUser\\Root" }),
      NOW,
    );
    expect(result.ok).toBe(false);
    expect(result.problems.join()).toContain("Root");
  });
});

describe("buildSigningCommand", () => {
  it("用 certificateSha1 而不是主体名（同名证书时才有唯一解）", () => {
    const { command } = buildSigningCommand(described());
    expect(command).toContain(
      "certificateSha1=AABBCCDDEEFF00112233445566778899AABBCCDD",
    );
  });

  it("命令里不带密码、不带私钥路径", () => {
    const { command } = buildSigningCommand(described());
    expect(command).not.toMatch(/password/i);
    expect(command).not.toMatch(/\.pfx/i);
  });

  it("不覆盖 signingHashAlgorithms（点号传数组会让 schema 报错，它留在 package.json）", () => {
    const { signtoolOptions } = buildSigningCommand(described());
    expect(Object.keys(signtoolOptions)).not.toContain("signingHashAlgorithms");
  });
});

describe("looksLikeModulePathProblem", () => {
  it("识别 -CodeSigningCert 参数缺失（PSModulePath 污染）", () => {
    expect(
      looksLikeModulePathProblem(
        "Get-ChildItem : 找不到与参数名称“CodeSigningCert”匹配的参数。\nFullyQualifiedErrorId : NamedParameterNotFound",
      ),
    ).toBe(true);
  });

  it("识别 Certificate 驱动器不存在", () => {
    expect(looksLikeModulePathProblem("Cannot find drive. A drive with the name 'Certificate' does not exist")).toBe(
      true,
    );
  });

  it("不把普通错误当成环境问题", () => {
    expect(looksLikeModulePathProblem("Access is denied")).toBe(false);
    expect(looksLikeModulePathProblem("")).toBe(false);
  });
});

describe("resolvePowershell", () => {
  it("非 Windows → SignPreflightError（不猜路径）", async () => {
    await expect(resolvePowershell({ platform: "linux" })).rejects.toBeInstanceOf(
      SignPreflightError,
    );
  });
});

describe("findSigntool", () => {
  it("非 Windows → path 为 null 且说明原因，不抛", async () => {
    const result = await findSigntool({ platform: "linux" });
    expect(result.path).toBeNull();
    expect(result.from).toBe("unsupported");
  });
});

describe("summarize", () => {
  it("没有证书 → 不可签，且说清 electron-builder 会静默跳过", () => {
    const summary = summarize({
      certs: [],
      selection: { kind: "no-selector", candidates: [] },
      assessment: { ok: false, problems: [] },
      signtool: { path: null, from: "kits-missing" },
    });
    expect(summary.ok).toBe(false);
    expect(summary.lines.join("\n")).toContain("no signing info identified");
  });

  it("有证书但没有选择器 → 不可签，并点名「不会自动挑」", () => {
    const cert = described();
    const summary = summarize({
      certs: [cert],
      selection: { kind: "no-selector", candidates: [cert] },
      assessment: { ok: false, problems: [] },
      signtool: { path: "x", from: "kits" },
    });
    expect(summary.ok).toBe(false);
    expect(summary.lines.join("\n")).toContain("不会自动挑");
  });

  it("可以签 → 给出命令，并提示打完后怎么验证", () => {
    const cert = described();
    const summary = summarize({
      certs: [cert],
      selection: { kind: "selected", cert },
      assessment: assessCertificate(cert, NOW),
      signtool: { path: "C:\\signtool.exe", from: "kits" },
    });
    const text = summary.lines.join("\n");
    expect(summary.ok).toBe(true);
    expect(text).toContain("certificateSha1=");
    expect(text).toContain("verify-signature.mjs");
  });

  it("可以签但 signtool 找不到 → 提醒会去下工具链", () => {
    const cert = described();
    const summary = summarize({
      certs: [cert],
      selection: { kind: "selected", cert },
      assessment: assessCertificate(cert, NOW),
      signtool: { path: null, from: "kits-missing" },
    });
    expect(summary.ok).toBe(true);
    expect(summary.lines.join("\n")).toContain("winCodeSign");
  });

  it("证书没有 CN → 警告 publisherName 写不出来（D-217）", () => {
    const cert = described({ Subject: "O=Mogenga, C=CN" });
    const summary = summarize({
      certs: [cert],
      selection: { kind: "selected", cert },
      assessment: assessCertificate(cert, NOW),
      signtool: { path: "x", from: "kits" },
    });
    expect(summary.lines.join("\n")).toContain("publisherName");
  });

  it("时间戳探测不可达 → 明说签名会成功但时间戳打不上", () => {
    const cert = described();
    const summary = summarize({
      certs: [cert],
      selection: { kind: "selected", cert },
      assessment: assessCertificate(cert, NOW),
      signtool: { path: "x", from: "kits" },
      timestamp: { url: DEFAULT_TIMESTAMP_SERVER, reachable: false, detail: "timeout" },
    });
    expect(summary.lines.join("\n")).toContain("不可达");
  });
});

describe("parseArgs", () => {
  it("默认值：不检查时间戳、不输出 JSON", () => {
    expect(parseArgs([])).toEqual({
      help: false,
      subjectName: null,
      sha1: null,
      checkTimestamp: false,
      json: false,
    });
  });

  it("--subject / --sha1 取值", () => {
    const parsed = parseArgs(["--subject", "Embedded", "--sha1", "AABB"]);
    expect(parsed.subjectName).toBe("Embedded");
    expect(parsed.sha1).toBe("AABB");
  });

  it("--subject 缺值 → 抛错（不当成空串）", () => {
    expect(() => parseArgs(["--subject"])).toThrow(SignPreflightError);
    expect(() => parseArgs(["--subject", "--json"])).toThrow(SignPreflightError);
  });

  it("未知参数 → 抛错", () => {
    expect(() => parseArgs(["--nope"])).toThrow(SignPreflightError);
  });

  it("--help 优先于其它参数", () => {
    expect(parseArgs(["--help"]).help).toBe(true);
  });
});
