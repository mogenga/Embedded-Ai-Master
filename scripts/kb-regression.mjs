#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = fileURLToPath(new URL("../", import.meta.url));
const SERVICE_MODULE = path.join(ROOT, "dist-mcp", "kb", "service.js");
const REPORT_MODULE = path.join(ROOT, "dist-mcp", "kb", "regression-report.js");
const YAML_MODULE = path.join(ROOT, "dist-mcp", "kb", "yaml.js");
const DEFAULT_KB_ROOT = path.join(ROOT, "mcp-servers", "kb", "kb");
const DATA_DIR = path.join(ROOT, "mcp-servers", "kb", "data");
const INDEX_FILE = "index.yaml";
const TOKEN_PATTERN = /0x[0-9A-Fa-f]+|[A-Za-z_][A-Za-z0-9_]*/g;
const SEARCH_LIMIT = 20;
const LOOKUP_LIMIT = 2;

const argv = process.argv.slice(2);
const outputJson = argv.includes("--json");
const outputBaseline = argv.includes("--baseline");
const unknown = argv.filter((arg) => arg !== "--json" && arg !== "--baseline");

function fail(message) {
  console.error(`kb regression: ${message}`);
  process.exitCode = 2;
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

function readJsonl(filePath) {
  const text = readFileSync(filePath, "utf8");
  const rows = [];
  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim();
    if (line === "") continue;
    let row;
    try {
      row = JSON.parse(line);
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} 不是合法 JSON: ${errorMessage(error)}`);
    }
    rows.push(row);
  }
  return rows;
}

function validateQueries(rows, filePath, expectedTrack) {
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id === "") {
      throw new Error(`${filePath}: 缺少 id`);
    }
    if (row.track !== expectedTrack) {
      throw new Error(`${filePath}: ${row.id} 的 track 应为 ${expectedTrack}，实际 ${row.track}`);
    }
    if (typeof row.text !== "string" || row.text.trim() === "") {
      throw new Error(`${filePath}: ${row.id} 缺少 text`);
    }
    if (!Array.isArray(row.gold) || row.gold.length === 0) {
      throw new Error(`${filePath}: ${row.id} 缺少非空 gold 数组`);
    }
    if (!row.gold.every((item) => typeof item === "string" && item !== "")) {
      throw new Error(`${filePath}: ${row.id} 的 gold 必须是非空字符串`);
    }
  }
}

function validateNegatives(rows, filePath) {
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id === "") {
      throw new Error(`${filePath}: 缺少 id`);
    }
    if (typeof row.text !== "string" || row.text.trim() === "") {
      throw new Error(`${filePath}: ${row.id} 缺少 text`);
    }
  }
}

function extractTokens(text) {
  const seen = new Map();
  for (const match of text.matchAll(TOKEN_PATTERN)) {
    const token = match[0];
    const key = token.toLowerCase();
    if (!seen.has(key)) seen.set(key, token);
  }
  return [...seen.values()];
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator;
}

function createIndexAccumulator() {
  return {
    total: 0,
    recallSum: 0,
    hitAt1: 0,
    mrrSum: 0,
    misses: [],
  };
}

function addIndexQuery(accumulator, query, service) {
  const result = service.lookup(query.text, LOOKUP_LIMIT);
  const candidatePaths = result.candidates.map((candidate) => candidate.path);
  const matched = query.gold.filter((gold) => candidatePaths.includes(gold));
  const rank = candidatePaths.findIndex((candidate) => query.gold.includes(candidate));

  accumulator.total += 1;
  accumulator.recallSum += matched.length / query.gold.length;
  if (rank === 0) accumulator.hitAt1 += 1;
  if (rank >= 0) accumulator.mrrSum += 1 / (rank + 1);

  if (matched.length < query.gold.length) {
    accumulator.misses.push({
      id: query.id,
      gold: query.gold,
      candidates: candidatePaths,
      reason: result.found ? "partial_or_wrong_rank" : (result.reason ?? "no_match"),
    });
  }
}

function summarizeIndex(accumulator) {
  return {
    total: accumulator.total,
    recallAt2: rate(accumulator.recallSum, accumulator.total),
    hitAt1: rate(accumulator.hitAt1, accumulator.total),
    mrr: rate(accumulator.mrrSum, accumulator.total),
    misses: accumulator.misses,
  };
}

function formatRate(value) {
  return value.toFixed(4);
}

function printTable(report) {
  console.log("KB regression");
  console.log(`  kb root: ${report.kbRoot}`);
  console.log(
    `  corpus: ${report.corpus.markdownFiles} md / ${report.corpus.indexEntries} index entries`,
  );
  console.log(
    `  queries: index ${report.corpus.indexQueries} / search ${report.corpus.searchQueries} / negatives ${report.corpus.negatives}`,
  );
  console.log("");
  console.log("index track");
  console.log(
    `  total ${report.index.total} | Recall@2 ${formatRate(report.index.recallAt2)} | Hit@1 ${formatRate(report.index.hitAt1)} | MRR ${formatRate(report.index.mrr)}`,
  );
  console.log(
    `  index-track gold indexed: ${report.indexLayers.goldIndexed.queries} / not indexed: ${report.indexLayers.goldNotIndexed.queries}`,
  );
  console.log(
    `  all queries gold indexed: ${report.layers.goldIndexed} / not indexed: ${report.layers.goldNotIndexed}`,
  );
  console.log("");
  console.log("search track");
  console.log(
    `  total ${report.search.total} | Hit@1 ${formatRate(report.search.hitAt1)} | goldInTop20 ${formatRate(report.search.goldInTop20)}`,
  );
  console.log("");
  console.log("negatives");
  console.log(
    `  total ${report.negatives.total} | refusalRate ${formatRate(report.negatives.refusalRate)} | falsePositives ${report.negatives.falsePositives.length}`,
  );
  console.log("");
  console.log(`index misses (${report.index.misses.length}):`);
  for (const miss of report.index.misses) {
    console.log(
      `  ${miss.id} gold=${miss.gold.join(",")} got=[${miss.candidates.join(", ")}] (${miss.reason})`,
    );
  }
  console.log(`search misses (${report.search.misses.length}):`);
  for (const miss of report.search.misses) {
    const first = miss.firstHit ? ` first=${miss.firstHit}` : "";
    console.log(
      `  ${miss.id} gold=${miss.gold.join(",")} tokens=[${miss.tokens.join(", ")}]${first} (${miss.reason})`,
    );
  }
  console.log(`negative false positives (${report.negatives.falsePositives.length}):`);
  for (const item of report.negatives.falsePositives) {
    console.log(`  ${item.id} candidates=[${item.candidates.join(", ")}]`);
  }
}

async function main() {
  if (unknown.length > 0) {
    fail(`未知参数: ${unknown.join(" ")}（可用 --json / --baseline）`);
    return;
  }
  if (!existsSync(SERVICE_MODULE)) {
    fail(`未找到 ${path.relative(ROOT, SERVICE_MODULE)}；请先运行 npm run build:mcp`);
    return;
  }
  if (!existsSync(REPORT_MODULE)) {
    fail(`未找到 ${path.relative(ROOT, REPORT_MODULE)}；请先运行 npm run build:mcp`);
    return;
  }
  if (!existsSync(YAML_MODULE)) {
    fail(`未找到 ${path.relative(ROOT, YAML_MODULE)}；请先运行 npm run build:mcp`);
    return;
  }

  const configuredRoot = process.env.KB_ROOT?.trim();
  const kbRoot = configuredRoot ? path.resolve(process.cwd(), configuredRoot) : DEFAULT_KB_ROOT;
  const queriesPath = path.join(DATA_DIR, "queries.jsonl");
  const negativesPath = path.join(DATA_DIR, "negatives.jsonl");

  if (!existsSync(kbRoot)) {
    fail(`KB 语料目录不存在: ${kbRoot}（可用 KB_ROOT 覆盖）`);
    return;
  }
  const indexPath = path.join(kbRoot, INDEX_FILE);
  if (!existsSync(indexPath)) {
    fail(`KB 索引不存在: ${indexPath}`);
    return;
  }
  if (!existsSync(queriesPath)) {
    fail(`查询集不存在: ${queriesPath}`);
    return;
  }
  if (!existsSync(negativesPath)) {
    fail(`负样本集不存在: ${negativesPath}`);
    return;
  }

  let queries;
  let negatives;
  try {
    queries = readJsonl(queriesPath);
    negatives = readJsonl(negativesPath);
    validateQueries(
      queries.filter((query) => query.track === "index"),
      queriesPath,
      "index",
    );
    validateQueries(
      queries.filter((query) => query.track === "search"),
      queriesPath,
      "search",
    );
    validateNegatives(negatives, negativesPath);
  } catch (error) {
    fail(errorMessage(error));
    return;
  }

  const untracked = queries.filter(
    (query) => query.track !== "index" && query.track !== "search",
  );
  if (untracked.length > 0) {
    fail(`queries.jsonl 含未知 track: ${untracked.map((query) => query.track).join(", ")}`);
    return;
  }

  let KbService;
  let createSearchAccumulator;
  let recordSearchResult;
  let parseIndexYaml;
  try {
    ({ KbService } = await import(pathToFileURL(SERVICE_MODULE).href));
    ({ createSearchAccumulator, recordSearchResult } = await import(
      pathToFileURL(REPORT_MODULE).href
    ));
    ({ parseIndexYaml } = await import(pathToFileURL(YAML_MODULE).href));
  } catch (error) {
    fail(`加载构建产物失败: ${errorMessage(error)}；请先运行 npm run build:mcp`);
    return;
  }
  const service = new KbService(kbRoot);
  const status = service.status();

  let indexPaths;
  try {
    indexPaths = new Set(parseIndexYaml(readFileSync(indexPath, "utf8")).map((entry) => entry.path));
  } catch (error) {
    fail(`index.yaml 解析失败: ${errorMessage(error)}`);
    return;
  }

  const indexQueries = queries.filter((query) => query.track === "index");
  const searchQueries = queries.filter((query) => query.track === "search");
  const overall = createIndexAccumulator();
  const indexedLayer = createIndexAccumulator();
  const notIndexedLayer = createIndexAccumulator();

  for (const query of indexQueries) {
    addIndexQuery(overall, query, service);
    const goldIndexed = query.gold.every((gold) => indexPaths.has(gold));
    addIndexQuery(goldIndexed ? indexedLayer : notIndexedLayer, query, service);
  }

  const search = createSearchAccumulator();
  for (const query of searchQueries) {
    const tokens = extractTokens(query.text);
    if (tokens.length === 0) {
      recordSearchResult(search, query, tokens, { found: false, hits: [] });
      continue;
    }
    const result = service.search(tokens, SEARCH_LIMIT);
    recordSearchResult(search, query, tokens, result);
  }

  const negativesReport = {
    total: 0,
    correct: 0,
    falsePositives: [],
  };
  for (const query of negatives) {
    const result = service.lookup(query.text);
    negativesReport.total += 1;
    if (result.found === false) {
      negativesReport.correct += 1;
    } else {
      negativesReport.falsePositives.push({
        id: query.id,
        candidates: result.candidates.map((candidate) => candidate.path),
      });
    }
  }

  const indexReport = summarizeIndex(overall);
  const indexedSummary = summarizeIndex(indexedLayer);
  const notIndexedSummary = summarizeIndex(notIndexedLayer);

  const goldIndexedQueries = queries.filter((query) =>
    query.gold.every((gold) => indexPaths.has(gold)),
  ).length;

  const report = {
    kbRoot,
    generatedAt: new Date().toISOString(),
    corpus: {
      markdownFiles: status.fileCount,
      indexEntries: status.indexEntries,
      indexQueries: indexQueries.length,
      searchQueries: searchQueries.length,
      negatives: negatives.length,
    },
    index: indexReport,
    search: {
      total: search.total,
      hitAt1: rate(search.hitAt1, search.total),
      goldInTop20: rate(search.goldInTop20, search.total),
      misses: search.misses,
    },
    negatives: {
      total: negativesReport.total,
      refusalRate: rate(negativesReport.correct, negativesReport.total),
      falsePositives: negativesReport.falsePositives,
    },
    layers: {
      goldIndexed: goldIndexedQueries,
      goldNotIndexed: queries.length - goldIndexedQueries,
    },
    indexLayers: {
      goldIndexed: {
        queries: indexedSummary.total,
        recallAt2: indexedSummary.recallAt2,
        hitAt1: indexedSummary.hitAt1,
        mrr: indexedSummary.mrr,
      },
      goldNotIndexed: {
        queries: notIndexedSummary.total,
        recallAt2: notIndexedSummary.recallAt2,
        hitAt1: notIndexedSummary.hitAt1,
        mrr: notIndexedSummary.mrr,
      },
    },
  };

  if (outputBaseline) {
    const baseline = {
      date: report.generatedAt.slice(0, 10),
      corpus: report.corpus,
      index: {
        total: report.index.total,
        recallAt2: report.index.recallAt2,
        hitAt1: report.index.hitAt1,
        mrr: report.index.mrr,
      },
      search: {
        total: report.search.total,
        hitAt1: report.search.hitAt1,
        goldInTop20: report.search.goldInTop20,
      },
      negatives: {
        total: report.negatives.total,
        refusalRate: report.negatives.refusalRate,
      },
      layers: report.layers,
    };
    console.log(JSON.stringify(baseline, null, 2));
    return;
  }

  if (outputJson) {
    console.log(JSON.stringify(report, null, 2));
    return;
  }

  printTable(report);
  console.log("");
  console.log("JSON");
  console.log(JSON.stringify(report, null, 2));
}

await main();