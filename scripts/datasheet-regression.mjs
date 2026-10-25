#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const ROOT = fileURLToPath(new URL("../", import.meta.url))
const SERVICE_MODULE = path.join(ROOT, "dist-mcp", "datasheet", "service.js")
const GATE_MODULE = path.join(ROOT, "dist-mcp", "datasheet", "regression-gate.js")
const CORPUS_DIR = path.join(ROOT, "mcp-servers", "datasheet", "corpus")
const DATA_DIR = path.join(ROOT, "mcp-servers", "datasheet", "data")
const BASELINE_FILE = path.join(ROOT, "mcp-servers", "datasheet", "tests", "regression-baseline.json")

const CORPUS_SHA256 = {
  "RM0008.pdf": "4c1b8ac2729cc1f45a4685eea9e91e6139e24e58804fba21e27201dfcc2ad149",
  "RM0090.pdf": "f3ff2322eec21f4e49081f68481b764506eee81dba6031bc767e2f8955b27cca",
}

const SEARCH_LIMIT = 5

const argv = process.argv.slice(2)
const outputJson = argv.includes("--json")
const outputBaseline = argv.includes("--baseline")
const updateBaseline = argv.includes("--update-baseline")
const unknown = argv.filter(
  (arg) => arg !== "--json" && arg !== "--baseline" && arg !== "--update-baseline",
)

function fail(message) {
  console.error(`datasheet regression: ${message}`)
  process.exitCode = 2
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error)
}

function readJsonl(filePath) {
  const text = readFileSync(filePath, "utf8")
  const rows = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].trim()
    if (line === "") continue
    let row
    try {
      row = JSON.parse(line)
    } catch (error) {
      throw new Error(`${filePath}:${index + 1} 不是合法 JSON: ${errorMessage(error)}`)
    }
    rows.push(row)
  }
  return rows
}

function validateQueries(rows, filePath) {
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id === "") throw new Error(`${filePath}: 缺少 id`)
    if (typeof row.query !== "string" || row.query.trim() === "")
      throw new Error(`${filePath}: ${row.id} 缺少 query`)
    if (typeof row.file !== "string" || row.file === "")
      throw new Error(`${filePath}: ${row.id} 缺少 file`)
    if (!Number.isInteger(row.page) || row.page < 1)
      throw new Error(`${filePath}: ${row.id} 的 page 必须是 1-based 正整数`)
  }
}

function validateNegatives(rows, filePath) {
  for (const row of rows) {
    if (typeof row.id !== "string" || row.id === "") throw new Error(`${filePath}: 缺少 id`)
    if (typeof row.query !== "string" || row.query.trim() === "")
      throw new Error(`${filePath}: ${row.id} 缺少 query`)
  }
}

function rate(numerator, denominator) {
  return denominator === 0 ? 0 : numerator / denominator
}

function sha256OfFile(filePath) {
  return createHash("sha256").update(readFileSync(filePath)).digest("hex")
}

function printTable(report) {
  console.log("Datasheet regression")
  console.log(`  corpus: ${report.corpus.files.join(", ")}`)
  console.log(
    `  queries: ${report.queries.total} | negatives: ${report.negatives.total}`,
  )
  console.log(
    `  queries  Recall@2 ${report.queries.recallAt2.toFixed(4)} | Hit@1 ${report.queries.hitAt1.toFixed(4)} | MRR ${report.queries.mrr.toFixed(4)}`,
  )
  console.log(
    `  negatives  falsePositiveRate ${report.negatives.falsePositiveRate.toFixed(4)} (${report.negatives.falsePositives.length} 条)`,
  )
  if (report.queries.misses.length > 0) {
    console.log(`query misses (${report.queries.misses.length}):`)
    for (const miss of report.queries.misses) {
      console.log(
        `  ${miss.id} gold=${miss.file}:${miss.page} got=[${miss.hits.map((h) => `${h.path}:${h.page}`).join(", ")}]`,
      )
    }
  }
  if (report.negatives.falsePositives.length > 0) {
    console.log(`negative false positives (${report.negatives.falsePositives.length}):`)
    for (const item of report.negatives.falsePositives) {
      console.log(
        `  ${item.id} first=${item.first.path}:${item.first.page} score=${Math.round(item.first.score)}`,
      )
    }
  }
}

async function main() {
  if (unknown.length > 0) {
    fail(`未知参数: ${unknown.join(" ")}（可用 --json / --baseline / --update-baseline）`)
    return
  }
  if (!existsSync(SERVICE_MODULE) || !existsSync(GATE_MODULE)) {
    fail("未找到 dist-mcp/datasheet；请先运行 npm run build:mcp")
    return
  }
  const queriesPath = path.join(DATA_DIR, "queries.jsonl")
  const negativesPath = path.join(DATA_DIR, "negatives.jsonl")
  if (!existsSync(queriesPath) || !existsSync(negativesPath)) {
    fail(`查询集不存在: ${DATA_DIR}（queries.jsonl / negatives.jsonl）`)
    return
  }
  const corpusFiles = Object.keys(CORPUS_SHA256).map((name) => path.join(CORPUS_DIR, name))
  for (const filePath of corpusFiles) {
    if (!existsSync(filePath)) {
      fail(
        `语料缺失: ${path.relative(ROOT, filePath)}（下载: node scripts/datasheet-corpus.mjs；出网需走本机代理）`,
      )
      return
    }
  }
  for (const [name, expected] of Object.entries(CORPUS_SHA256)) {
    const actual = sha256OfFile(path.join(CORPUS_DIR, name))
    if (actual !== expected) {
      fail(`语料哈希不符: ${name} 期望 ${expected} 实际 ${actual}（重新下载或重标基线）`)
      return
    }
  }

  let queries
  let negatives
  try {
    queries = readJsonl(queriesPath)
    negatives = readJsonl(negativesPath)
    validateQueries(queries, queriesPath)
    validateNegatives(negatives, negativesPath)
  } catch (error) {
    fail(errorMessage(error))
    return
  }

  const { DatasheetService } = await import(pathToFileURL(SERVICE_MODULE).href)
  const { DatasheetCache } = await import(
    pathToFileURL(path.join(ROOT, "dist-mcp", "datasheet", "cache.js")).href
  )
  const cacheDir = path.join(CORPUS_DIR, ".datasheet-mcp")
  const service = new DatasheetService(CORPUS_DIR, new DatasheetCache(cacheDir))

  const misses = []
  let recallSum = 0
  let hitAt1 = 0
  let mrrSum = 0
  for (const query of queries) {
    const result = await service.search(query.query, SEARCH_LIMIT)
    const rank = result.hits.findIndex(
      (hit) => hit.path === query.file && hit.page === query.page,
    )
    if (rank === 0) hitAt1 += 1
    if (rank >= 0) mrrSum += 1 / (rank + 1)
    if (rank < 2) recallSum += 1
    if (rank !== 0) {
      misses.push({
        id: query.id,
        file: query.file,
        page: query.page,
        rank,
        hits: result.hits.slice(0, 3),
      })
    }
  }

  const falsePositives = []
  for (const negative of negatives) {
    const result = await service.search(negative.query, SEARCH_LIMIT)
    if (result.hits.length > 0) {
      falsePositives.push({ id: negative.id, first: result.hits[0] })
    }
  }

  const report = {
    generatedAt: new Date().toISOString(),
    corpus: { files: Object.keys(CORPUS_SHA256), dir: CORPUS_DIR },
    queries: {
      total: queries.length,
      recallAt2: rate(recallSum, queries.length),
      hitAt1: rate(hitAt1, queries.length),
      mrr: rate(mrrSum, queries.length),
      misses,
    },
    negatives: {
      total: negatives.length,
      falsePositiveRate: rate(falsePositives.length, negatives.length),
      falsePositives,
    },
  }

  if (outputBaseline || updateBaseline) {
    const baseline = {
      date: report.generatedAt.slice(0, 10),
      queries: {
        total: report.queries.total,
        recallAt2: report.queries.recallAt2,
        hitAt1: report.queries.hitAt1,
        mrr: report.queries.mrr,
      },
      negatives: {
        total: report.negatives.total,
        falsePositiveRate: report.negatives.falsePositiveRate,
      },
    }
    if (updateBaseline) {
      const { writeFileSync } = await import("node:fs")
      writeFileSync(BASELINE_FILE, JSON.stringify(baseline, null, 2) + "\n", "utf8")
      console.log(`基线已更新: ${path.relative(ROOT, BASELINE_FILE)}`)
      return
    }
    console.log(JSON.stringify(baseline, null, 2))
    return
  }
  if (outputJson) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printTable(report)

  if (!existsSync(BASELINE_FILE)) {
    fail(`基线不存在: ${path.relative(ROOT, BASELINE_FILE)}（先 --update-baseline）`)
    return
  }
  const baseline = JSON.parse(readFileSync(BASELINE_FILE, "utf8"))
  const { compareDatasheetRegression } = await import(pathToFileURL(GATE_MODULE).href)
  const gate = compareDatasheetRegression(report, baseline)
  console.log("")
  if (gate.ok) {
    console.log("回归门禁: PASS（不低于基线）")
  } else {
    console.log("回归门禁: FAIL")
    for (const failure of gate.failures) {
      console.log(
        `  ${failure.metric}: expected ${failure.expected} actual ${failure.actual}`,
      )
    }
    process.exitCode = 1
  }
}

await main()