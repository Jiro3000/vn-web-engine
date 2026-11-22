#!/usr/bin/env node
/**
 * SiglusEngine SSR benchmark comparator & worst-causes reporter
 * adapted from Yu-RIS's goal-compare.py + worst-causes.py.
 *
 * Usage:
 *   node tools/compare-siglus-benchmark.mjs RUN
 *   node tools/compare-siglus-benchmark.mjs --base BASE1 [BASE2] RUN [--target 1.5]
 *   node tools/compare-siglus-benchmark.mjs --causes RUN [N]
 */
import {readFileSync} from 'node:fs';
import {join, resolve} from 'node:path';

const LOWER = [
  'workTotalMs',
  'workMean',
  'workP50',
  'workP95',
  'workP99',
  'workMax',
  'workTop10',
  'workGt16',
  'workGt50',
  'workGt100',
  'rafMean',
  'rafP50',
  'rafP95',
  'rafP99',
  'rafMax',
  'rafTop10',
  'rafGt50',
  'rafGt100',
  'gapP95',
  'gapGt50',
  'gapGt100',
  'gapMax',
  'longTaskTotalMs',
  'longTaskCount',
];

const CRITERIA = [
  'workTotalMs',
  'workMean',
  'workP95',
  'workMax',
  'workTop10',
  'workGt50',
  'workGt100',
  'rafP95',
  'rafMax',
  'rafTop10',
  'longTaskTotalMs',
  'longTaskCount',
];

function loadRun(dir) {
  const root = resolve(dir);
  const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
  const browser = JSON.parse(readFileSync(join(root, 'browser-report.json'), 'utf8'));
  const w = summary.allClicksWork ?? {};
  const r = summary.clickToRenderOpportunity ?? {};
  const g = summary.transitionGaps ?? {};
  const lt = summary.mainThreadLongTasks ?? {};
  const metrics = {
    workTotalMs: w.total ?? 0,
    workMean: w.mean ?? 0,
    workP50: w.p50 ?? 0,
    workP95: w.p95 ?? 0,
    workP99: w.p99 ?? 0,
    workMax: w.max ?? 0,
    workTop10: w.top10 ?? 0,
    workGt16: w.gt16 ?? 0,
    workGt50: w.gt50 ?? 0,
    workGt100: w.gt100 ?? 0,
    rafMean: r.mean ?? 0,
    rafP50: r.p50 ?? 0,
    rafP95: r.p95 ?? 0,
    rafP99: r.p99 ?? 0,
    rafMax: r.max ?? 0,
    rafTop10: r.top10 ?? 0,
    rafGt50: r.gt50 ?? 0,
    rafGt100: r.gt100 ?? 0,
    gapP95: g.p95 ?? 0,
    gapGt50: g.gt50 ?? 0,
    gapGt100: g.gt100 ?? 0,
    gapMax: g.max ?? 0,
    longTaskTotalMs: lt.total ?? 0,
    longTaskCount: lt.n ?? 0,
    storyWallMs: summary.storyWallMs,
    clicksPerSecond: summary.clicksPerSecond,
    peakJsHeapMiB: summary.peakJsHeapMiB,
  };
  const correctness = {
    complete: summary.complete,
    revision: summary.revision,
    clicks: summary.clickLimit?.clicks,
    end: summary.end,
    exceptions: summary.console?.exceptions ?? 0,
    consoleWarningsAndErrors: summary.console?.warningsAndErrors ?? 0,
    gameUnchanged: summary.gameUnchanged,
    voiceStarts: summary.audio?.voiceStarts ?? 0,
    g00Needed: summary.g00?.needed ?? 0,
    g00HitRate: summary.g00?.hitRate ?? 0,
  };
  return {summary, metrics, correctness, domText: browser.domText ?? []};
}

function compareDomText(baseRows, runRows) {
  const n = Math.min(baseRows.length, runRows.length);
  const posDiffs = [];
  const textDiffs = [];
  for (let i = 0; i < n; i++) {
    const a = baseRows[i];
    const b = runRows[i];
    const samePos = a.where[0] === b.where[0] && a.where[1] === b.where[1] && a.page === b.page;
    if (!samePos) posDiffs.push([i, a.where, b.where]);
    else if (a.flat !== b.flat) textDiffs.push([i, a.where, a.flat, b.flat]);
  }
  return {
    baseClicks: baseRows.length,
    runClicks: runRows.length,
    compared: n,
    positionDifferences: posDiffs.length,
    firstPositionDifference: posDiffs[0] ?? null,
    textDifferences: textDiffs.length,
    firstTextDifferences: textDiffs.slice(0, 10),
  };
}

function printCauses(dir, count = 20) {
  const root = resolve(dir);
  const summary = JSON.parse(readFileSync(join(root, 'summary.json'), 'utf8'));
  console.log('== PHASE TOTALS ==');
  const sortedPhases = Object.entries(summary.phaseTotals ?? {}).sort(
    (a, b) => b[1].totalMs - a[1].totalMs,
  );
  for (const [name, info] of sortedPhases) {
    console.log(
      `  ${name.padEnd(16)} ${String(info.totalMs).padStart(9)} ms  (${info.count} calls, avg ${
        info.count ? (info.totalMs / info.count).toFixed(2) : '0.00'
      } ms)`,
    );
  }
  console.log(`\n== WORST ${count} CLICKS BY ACTIVE WORK ==`);
  for (const r of (summary.worstResponses ?? []).slice(0, count)) {
    const phases = Object.entries(r.phases ?? {})
      .filter(([, v]) => v >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v.toFixed(1)}`)
      .join(' ');
    console.log(
      `  #${String(r.index).padStart(4)} work=${r.workMs.toFixed(1).padStart(6)}ms raf=${r.rafMs
        .toFixed(1)
        .padStart(6)}ms ${r.from[0]}:${r.from[1]} -> ${r.to[0]}:${r.to[1]}  [${phases}]`,
    );
    for (const g of r.g00 ?? []) console.log(`         g00 ${g[0]}#${g[1]} cached=${g[2]} ${g[3]}ms`);
    for (const v of r.voices ?? []) console.log(`         voice #${v[0]} ${v[1]}ms`);
  }
  console.log(`\n== WORST ${count} ORDINARY CLICKS BY CLICK->RAF ==`);
  for (const r of (summary.worstOrdinaryRaf ?? []).slice(0, count)) {
    const phases = Object.entries(r.phases ?? {})
      .filter(([, v]) => v >= 0.5)
      .sort((a, b) => b[1] - a[1])
      .map(([k, v]) => `${k}=${v.toFixed(1)}`)
      .join(' ');
    console.log(
      `  #${String(r.index).padStart(4)} raf=${r.rafMs.toFixed(1).padStart(6)}ms work=${r.workMs
        .toFixed(1)
        .padStart(6)}ms ${r.from[0]}:${r.from[1]}  [${phases}]`,
    );
  }
}

const args = process.argv.slice(2);
if (args[0] === '--causes') {
  printCauses(args[1], Number(args[2] ?? 20));
  process.exit(0);
}

let target = 1.5;
const targetIdx = args.indexOf('--target');
if (targetIdx !== -1) {
  target = Number(args[targetIdx + 1]);
  args.splice(targetIdx, 2);
}

const baseDirs = [];
if (args[0] === '--base') {
  args.shift();
  while (args.length > 1) baseDirs.push(args.shift());
}
const runDir = args[0];
if (!runDir) {
  throw new Error(
    'Usage: compare-siglus-benchmark.mjs [--base B1 [B2]] RUN [--target 1.5] | --causes RUN [N]',
  );
}

const run = loadRun(runDir);
const out = {
  run: runDir,
  metrics: run.metrics,
  phaseTotals: run.summary.phaseTotals,
  correctness: run.correctness,
};

if (baseDirs.length) {
  const bases = baseDirs.map((d) => loadRun(d));
  const best = {};
  const speedup = {};
  for (const k of LOWER) {
    best[k] = Math.min(...bases.map((b) => b.metrics[k]));
    speedup[k] = run.metrics[k] > 0 ? Number((best[k] / run.metrics[k]).toFixed(3)) : null;
  }
  const criteria = {};
  for (const k of CRITERIA) {
    criteria[k] = run.metrics[k] * target <= best[k];
  }
  out.base = {
    runs: baseDirs,
    targetSpeedup: target,
    best,
    baseOverRun: speedup,
    criteria,
    allCriteriaMet: Object.values(criteria).every(Boolean),
  };
  out.dom = compareDomText(bases[0].domText, run.domText);
}

console.log(JSON.stringify(out, null, 2));
