#!/usr/bin/env node
/**
 * Phase 2: Structural-anchor + constant-preserving hash cross-version matcher
 * and transitive engine call-graph reachability analyzer.
 *
 * Strictly preserves semantic boundaries:
 *   - Distinguishes exact_binary_identity, probable_semantic_equivalence,
 *     structural_correspondence, proven_semantic_equivalence, and unresolved.
 *   - Never forces low-confidence matches.
 *   - Records transitive reachability explicitly as a lower bound and preserves
 *     every indirect-call / vtable / function-pointer frontier as a coverage gap.
 *
 * Usage:
 *   node tools/siglus-inventory/match.mjs --ids hoshiori-rikka,anemoi --out targetgame/siglus-inventory/checkpoints/pilot-match.json
 *   node tools/siglus-inventory/match.mjs --all --out docs/siglus/cross-version-summary.json
 */

import fs from 'node:fs';
import path from 'node:path';
import {MATCH_MAP_SCHEMA, validateMatchMap} from './schema.mjs';

const REPO_ROOT = path.resolve(import.meta.dirname, '../..');
const CORPUS_PATH = path.join(import.meta.dirname, 'corpus.json');
const EXPORTS_DIR = path.join(REPO_ROOT, 'targetgame/siglus-inventory/exports');
const CHECKPOINTS_DIR = path.join(REPO_ROOT, 'targetgame/siglus-inventory/checkpoints');

const LIBRARY_STOP_BUCKETS = new Set(['crt_stl', 'win32_directx_wrapper', 'third_party_codec']);

/**
 * Anchor specifications: deterministic structural + string rules.
 * Disambiguated by switch-case count, code locality near dispatcher.global,
 * and call-graph reachability.
 */
const STRING_ANCHOR_SPECS = [
  {id: 'dispatcher.global', needle: '無効なコマンドが指定されました。(global)', minSwitch: 80},
  {id: 'dispatcher.syscom', needle: '無効なコマンドが指定されました。(syscom)', minSwitch: 200},
  {id: 'dispatcher.object', needle: 'create コマンドで指定したファイル名が空です。', minSwitch: 100},
  {id: 'dispatcher.script', needle: '無効なコマンドが指定されました。(script)', minSwitch: 50},
  {id: 'dispatcher.excall', needle: '無効なコマンドが指定されました。(excall)'},
  {id: 'dispatcher.screen', needle: '無効なコマンドが指定されました。(screen)', minSwitch: 15},
  {id: 'dispatcher.effect', needle: '無効なコマンドが指定されました。(effect)', minSwitch: 15},
  {id: 'dispatcher.effectlist', needle: '無効なコマンドが指定されました。(effectlist)'},
  {id: 'dispatcher.quake', needle: '無効なコマンドが指定されました。(quake)'},
  {id: 'dispatcher.quakelist', needle: '無効なコマンドが指定されました。(quakelist)'},
  {id: 'dispatcher.input', needle: '無効なコマンドが指定されました。(input)', preferNearGlobal: true},
  {id: 'dispatcher.mouse', needle: '無効なコマンドが指定されました。(mouse)', preferNearGlobal: true},
  {id: 'dispatcher.keylist', needle: '無効なコマンドが指定されました。(keylist)', preferNearGlobal: true},
  {id: 'dispatcher.key', needle: '無効なコマンドが指定されました。(key)', preferNearGlobal: true},
  {id: 'dispatcher.msgbk', needle: '無効なコマンドが指定されました。(msgbk)'},
  {id: 'dispatcher.intevent', needle: '無効なコマンドが指定されました。(intevent)'},
  {id: 'dispatcher.str', needle: '無効なコマンドが指定されました。(str)'},
  {id: 'dispatcher.math', needle: '無効なコマンドが指定されました。(math)', minSwitch: 10},
  {id: 'dispatcher.cgtable', needle: '無効なコマンドが指定されました。(cgtable)'},
  {id: 'dispatcher.bgmtable', needle: '無効なコマンドが指定されました。(bgmtable)'},
  {id: 'dispatcher.bgm', needle: '無効なコマンドが指定されました。(bgm)'},
  {id: 'dispatcher.koe', needle: '無効なコマンドが指定されました。(koe)'},
  {id: 'dispatcher.pcm', needle: '無効なコマンドが指定されました。(pcm)'},
  {id: 'dispatcher.pcmch', needle: '無効なコマンドが指定されました。(pcmch)'},
  {id: 'dispatcher.pcmchlist', needle: '無効なコマンドが指定されました。(pcmchlist)'},
  {id: 'dispatcher.se', needle: '無効なコマンドが指定されました。(se)'},
  {id: 'dispatcher.mov', needle: '無効なコマンドが指定されました。(mov)'},
  {id: 'dispatcher.pcmevent', needle: '無効なコマンドが指定されました。(pcmevent)'},
  {id: 'dispatcher.system', needle: '無効なコマンドが指定されました。(system)', minSwitch: 10},
  {id: 'dispatcher.world', needle: '無効なコマンドが指定されました。(world)'},
  {id: 'dispatcher.world_list', needle: '無効なコマンドが指定されました。(world_list)'},
  {id: 'dispatcher.call', needle: '無効なコマンドが指定されました。(call)'},
  {id: 'dispatcher.calllist', needle: '無効なコマンドが指定されました。（calllist）'},
  {id: 'dispatcher.btnselitem', needle: '無効なコマンドが指定されました。(btnselitem)'},
  {id: 'dispatcher.btnselitem_list', needle: '無効なコマンドが指定されました。(btnselitem_list)'},
  {id: 'parser.gameexe.core', needle: '#SCREEN_SIZE = %d , %d'},
  {id: 'parser.gameexe.extended', needle: '#MWND . CNT = %d'},
  {id: 'loader.scene_pck', needle: 'シーンデータ（Scene.pck）が開けませんでした。', pickLargest: true},
  {id: 'decoder.g00', needle: 'つ目の指定の画像ファイル名が空です。'},
  {id: 'decoder.dbs', needle: '.dbs', preferSmallestEngine: true},
  {id: 'decoder.omv', needle: '.omv が見つかりませんでした。', pickLargest: true},
  {id: 'decoder.cgtable', needle: 'CGTABLE', excludeGameexe: true},
  {id: 'decoder.ovk', exactString: 'ovk'},
  {id: 'decoder.owp', exactString: 'owp'},
  {id: 'decoder.g00_loader', exactString: 'g00', pickLargest: true},
  {id: 'runtime.save_file', exactString: '.sav'},
  {id: 'runtime.frame_action', needle: '.frame_action', pickLargest: true},
];

function maxSwitchCases(fn) {
  if (!fn.switchTableInfo?.length) return 0;
  return Math.max(...fn.switchTableInfo.map((s) => s.caseCount));
}

function vaToNum(va) {
  return parseInt(va, 16);
}

/**
 * Discover structural anchors in a single exported binary inventory.
 */
export function discoverAnchors(inv) {
  const anchors = {};
  if (inv.binary.containerKind === 'packed-pe') {
    for (const spec of STRING_ANCHOR_SPECS) {
      anchors[spec.id] = {
        status: 'packed_binary_blocker',
        va: null,
        rva: null,
        reason: 'Executable is statically packed on disk; native dispatchers are not exposed statically.',
      };
    }
    anchors['dispatcher.mwnd'] = {
      status: 'packed_binary_blocker',
      va: null,
      rva: null,
      reason: 'Executable is statically packed on disk; native dispatchers are not exposed statically.',
    };
    return anchors;
  }

  const byVa = new Map(inv.functions.map((f) => [f.va, f]));

  // Pass 1: find dispatcher.global first so we can disambiguate nearby dispatchers
  const globalSpec = STRING_ANCHOR_SPECS[0];
  const globalHits = inv.functions.filter(
    (f) => f.stringXrefs.some((s) => s.includes(globalSpec.needle)) && maxSwitchCases(f) >= globalSpec.minSwitch,
  );
  const globalFn = globalHits[0] ?? null;
  const globalAddr = globalFn ? vaToNum(globalFn.va) : null;

  // Build 2-hop callee set from global dispatcher for disambiguation
  const nearGlobalCallees = new Set();
  if (globalFn) {
    nearGlobalCallees.add(globalFn.va);
    for (const c1 of globalFn.callees) {
      nearGlobalCallees.add(c1);
      const f1 = byVa.get(c1);
      if (f1) {
        for (const c2 of f1.callees) nearGlobalCallees.add(c2);
      }
    }
  }

  // Pass 2: locate all string-anchored functions
  for (const spec of STRING_ANCHOR_SPECS) {
    let candidates = inv.functions.filter((f) => {
      if (spec.exactString) {
        if (!f.stringXrefs.some((s) => s === spec.exactString)) return false;
      } else if (!f.stringXrefs.some((s) => s.includes(spec.needle))) {
        return false;
      }
      if (spec.minSwitch && maxSwitchCases(f) < spec.minSwitch) return false;
      if (spec.excludeGlobal && globalFn && f.va === globalFn.va) return false;
      if (spec.excludeGameexe && f.stringXrefs.some((s) => s.includes('#MWND') || s.includes('#SCREEN_SIZE'))) {
        return false;
      }
      return true;
    });

    // Prefer exact clean string match (avoid preceding junk bytes from jump tables)
    if (spec.needle) {
      const clean = candidates.filter((f) =>
        f.stringXrefs.some((s) => s === spec.needle || s.startsWith(spec.needle)),
      );
      if (clean.length > 0) candidates = clean;
    }

    if (candidates.length > 1 && spec.preferNearGlobal) {
      const inDisp = candidates.filter((f) => nearGlobalCallees.has(f.va));
      if (inDisp.length > 0) candidates = inDisp;
      else if (globalAddr !== null) {
        candidates.sort((a, b) => Math.abs(vaToNum(a.va) - globalAddr) - Math.abs(vaToNum(b.va) - globalAddr));
      }
    }
    if (candidates.length > 1 && spec.pickLargest) {
      candidates.sort((a, b) => b.byteLength - a.byteLength);
    }
    if (candidates.length > 1 && spec.preferSmallestEngine) {
      candidates = candidates.filter((f) => f.bucket === 'engine_candidate');
      candidates.sort((a, b) => a.byteLength - b.byteLength);
    }

    const picked = candidates[0] ?? null;
    if (picked) {
      const inlinedIntoGlobal = Boolean(globalFn && picked.va === globalFn.va && spec.id !== 'dispatcher.global');
      anchors[spec.id] = {
        status: 'anchored',
        va: picked.va,
        rva: picked.rva,
        byteLength: picked.byteLength,
        maxSwitchCases: maxSwitchCases(picked),
        rawBytesSha256: picked.rawBytesSha256,
        normalizedInsnSha256: picked.normalizedInsnSha256,
        cfgShapeSha256: picked.cfgShapeSha256,
        candidateCount: candidates.length,
        ...(inlinedIntoGlobal ? {inlinedInto: 'dispatcher.global'} : {}),
        evidence: spec.exactString ? `exact-string:${spec.exactString}` : `string:${spec.needle}`,
      };
    } else {
      anchors[spec.id] = {
        status: 'missing',
        va: null,
        rva: null,
        reason: `No function matched anchor rule ${spec.id} (${spec.exactString ?? spec.needle})`,
      };
    }
  }

  // Pass 3: structural anchors for unnamed sub-dispatchers near dispatcher.global
  const makeAnchor = (fn, evidence, candidateCount = 1) => ({
    status: 'anchored',
    va: fn.va,
    rva: fn.rva,
    byteLength: fn.byteLength,
    maxSwitchCases: maxSwitchCases(fn),
    rawBytesSha256: fn.rawBytesSha256,
    normalizedInsnSha256: fn.normalizedInsnSha256,
    cfgShapeSha256: fn.cfgShapeSha256,
    candidateCount,
    evidence,
  });

  const nearUnnamed = [...nearGlobalCallees]
    .map((va) => byVa.get(va))
    .filter((f) => f && f.stringXrefs.some((s) => s === '無効なコマンドが指定されました。'));

  // dispatcher.mwnd: 65..105 switch cases
  const mwndCand = inv.functions.filter((f) => {
    const sc = maxSwitchCases(f);
    return (
      sc >= 65 &&
      sc <= 105 &&
      f.stringXrefs.some((s) => s.includes('無効なコマンドが指定されました。')) &&
      (!globalFn || f.va !== globalFn.va) &&
      f.va !== anchors['dispatcher.script']?.va
    );
  });
  mwndCand.sort((a, b) => (nearGlobalCallees.has(a.va) ? 0 : 1) - (nearGlobalCallees.has(b.va) ? 0 : 1) || b.byteLength - a.byteLength);
  anchors['dispatcher.mwnd'] = mwndCand[0]
    ? makeAnchor(mwndCand[0], 'switch-shape:65..105+invalid-cmd-string', mwndCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No MWND switch candidate found'};

  // dispatcher.intlist_or_eventlist: four 7-case switches [7,7,7,7]
  const intEvCand = nearUnnamed.filter((f) => (f.switchTableInfo?.filter((s) => s.caseCount === 7).length ?? 0) >= 3);
  anchors['dispatcher.intlist_event'] = intEvCand[0]
    ? makeAnchor(intEvCand[0], 'switch-shape:[7,7,7,7]+near-global', intEvCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No [7,7,7,7] switch dispatcher near global'};

  // dispatcher.database: 8-case switch near global
  const dbCand = nearUnnamed.filter((f) => f.switchTableInfo?.some((s) => s.caseCount === 8));
  anchors['dispatcher.database'] = dbCand[0]
    ? makeAnchor(dbCand[0], 'switch-shape:[8]+near-global', dbCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No [8] database switch dispatcher near global'};

  // dispatcher.objectlist: calls dispatcher.object and has constant 1300
  const objVa = anchors['dispatcher.object']?.va;
  const objListCand = nearUnnamed.filter(
    (f) => f.semanticConstants.includes(1300) && (!objVa || f.callees.includes(objVa)),
  );
  anchors['dispatcher.objectlist'] = objListCand[0]
    ? makeAnchor(objListCand[0], 'callee:dispatcher.object+const:1300', objListCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No objectlist dispatcher near global'};

  // dispatcher.stage: near global, has constant 160 and calls objectlist or mwnd
  const stageCand = nearUnnamed.filter(
    (f) => f.semanticConstants.includes(160) && (f.callees.includes(anchors['dispatcher.mwnd']?.va) || f.callees.includes(objListCand[0]?.va)),
  );
  anchors['dispatcher.stage'] = stageCand[0]
    ? makeAnchor(stageCand[0], 'const:160+calls-stage-children', stageCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No stage dispatcher near global'};

  // dispatcher.counter & dispatcher.mask: unnamed dispatchers near global with consts [2,3,4,5,6,7,8,9] / [2,3,4,5,7,8,9,10]
  const counterCand = nearUnnamed.filter(
    (f) =>
      f.va !== anchors['dispatcher.mwnd']?.va &&
      f.va !== anchors['dispatcher.stage']?.va &&
      !f.switchTableInfo?.length &&
      [2, 3, 4, 5, 6, 7, 8, 9].every((c) => f.semanticConstants.includes(c)) &&
      f.byteLength >= 550 &&
      f.byteLength <= 1150,
  );
  counterCand.sort((a, b) => a.callees.length - b.callees.length);
  anchors['dispatcher.counter'] = counterCand[0]
    ? makeAnchor(counterCand[0], 'consts:2..9+near-global-unnamed', counterCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No counter dispatcher candidate'};

  const maskCand = nearUnnamed.filter(
    (f) =>
      f.va !== counterCand[0]?.va &&
      f.va !== anchors['dispatcher.stage']?.va &&
      !f.switchTableInfo?.length &&
      [2, 3, 4, 5, 7, 8, 9, 10].every((c) => f.semanticConstants.includes(c)) &&
      f.byteLength >= 600 &&
      f.byteLength <= 1100,
  );
  anchors['dispatcher.mask'] = maskCand[0]
    ? makeAnchor(maskCand[0], 'consts:2..5,7..10+near-global-unnamed', maskCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No mask dispatcher candidate'};

  // dispatcher.group: objbtngroup dispatcher (near stage or 15-case switch or callee of stage)
  const groupCand = nearUnnamed.filter(
    (f) =>
      f.switchTableInfo?.some((s) => s.caseCount >= 12 && s.caseCount <= 20) ||
      (anchors['dispatcher.stage']?.va &&
        byVa.get(anchors['dispatcher.stage'].va)?.callees.includes(f.va) &&
        f.va !== anchors['dispatcher.mwnd']?.va &&
        f.va !== anchors['dispatcher.objectlist']?.va),
  );
  anchors['dispatcher.group'] = groupCand[0]
    ? makeAnchor(groupCand[0], 'stage-child-or-switch:12..20', groupCand.length)
    : {status: 'missing', va: null, rva: null, reason: 'No group dispatcher candidate'};

  return anchors;
}

/**
 * Compute transitive call-graph reachability from all anchored engine entry surfaces.
 * Stops at verified library boundaries; explicitly records reachability as a lower bound
 * and captures every unresolved indirect-call / vtable / function-pointer frontier.
 */
export function computeReachability(inv, anchors) {
  if (inv.binary.containerKind === 'packed-pe') {
    return {
      isLowerBound: true,
      packedBlocker: true,
      entryRoots: [],
      reachableCount: 0,
      reachableVas: [],
      boundaryStoppedCounts: {},
      indirectCallFrontierCount: 0,
      indirectCallSiteCount: 0,
      indirectCallFrontierSample: [],
    };
  }

  const byVa = new Map(inv.functions.map((f) => [f.va, f]));
  const entryRoots = [];
  const queue = [];
  const visited = new Set();

  for (const [anchorId, info] of Object.entries(anchors)) {
    if (info.va && byVa.has(info.va)) {
      entryRoots.push({anchorId, va: info.va});
      if (!visited.has(info.va)) {
        visited.add(info.va);
        queue.push(info.va);
      }
    }
  }

  const boundaryStoppedCounts = {};
  const indirectFrontier = [];
  let totalIndirectSites = 0;

  while (queue.length > 0) {
    const va = queue.shift();
    const fn = byVa.get(va);
    if (!fn) continue;

    if (fn.indirectCallSites.length > 0) {
      totalIndirectSites += fn.indirectCallSites.length;
      indirectFrontier.push({
        va: fn.va,
        rva: fn.rva,
        bucket: fn.bucket,
        siteCount: fn.indirectCallSites.length,
        kinds: [...new Set(fn.indirectCallSites.map((s) => s.kind))],
      });
    }

    for (const calleeVa of fn.callees) {
      if (visited.has(calleeVa)) continue;
      const callee = byVa.get(calleeVa);
      if (!callee) continue;
      if (LIBRARY_STOP_BUCKETS.has(callee.bucket)) {
        boundaryStoppedCounts[callee.bucket] = (boundaryStoppedCounts[callee.bucket] ?? 0) + 1;
        continue;
      }
      if (callee.bucket === 'thunk' && callee.importXrefs.length > 0 && callee.callees.length === 0) {
        boundaryStoppedCounts.iat_thunk = (boundaryStoppedCounts.iat_thunk ?? 0) + 1;
        continue;
      }
      visited.add(calleeVa);
      queue.push(calleeVa);
    }
  }

  const reachableVas = [...visited].sort((a, b) => vaToNum(a) - vaToNum(b));
  indirectFrontier.sort((a, b) => b.siteCount - a.siteCount);

  return {
    isLowerBound: true,
    packedBlocker: false,
    entryRoots,
    reachableCount: reachableVas.length,
    reachableVas,
    boundaryStoppedCounts,
    indirectCallFrontierCount: indirectFrontier.length,
    indirectCallSiteCount: totalIndirectSites,
    indirectCallFrontierTop: indirectFrontier.slice(0, 50),
  };
}

function constantDiff(aConsts = [], bConsts = []) {
  const sa = new Set(aConsts);
  const sb = new Set(bConsts);
  const added = [...sb].filter((x) => !sa.has(x));
  const removed = [...sa].filter((x) => !sb.has(x));
  return {added, removed, equal: added.length === 0 && removed.length === 0};
}

function stringJaccard(aStrs = [], bStrs = []) {
  const filt = (arr) => arr.filter((s) => s.length >= 6 && s !== '無効なコマンドが指定されました。');
  const sa = new Set(filt(aStrs));
  const sb = new Set(filt(bStrs));
  if (sa.size === 0 || sb.size === 0) return 0;
  let inter = 0;
  for (const s of sa) if (sb.has(s)) inter++;
  return inter / (sa.size + sb.size - inter);
}

function buildDiffDetails(fnA, fnB) {
  const cd = constantDiff(fnA.semanticConstants, fnB.semanticConstants);
  const sa = new Set(fnA.stringXrefs);
  const sb = new Set(fnB.stringXrefs);
  return {
    bytesDelta: fnB.byteLength - fnA.byteLength,
    insnsDelta: fnB.insnCount - fnA.insnCount,
    blocksDelta: fnB.blockCount - fnA.blockCount,
    switchCasesFrom: maxSwitchCases(fnA),
    switchCasesTo: maxSwitchCases(fnB),
    constantsEqual: cd.equal,
    addedConstants: cd.added.slice(0, 12),
    removedConstants: cd.removed.slice(0, 12),
    addedStrings: [...sb].filter((s) => !sa.has(s)).slice(0, 8),
    removedStrings: [...sa].filter((s) => !sb.has(s)).slice(0, 8),
  };
}

/**
 * Tiered deterministic matching of reachable engine functions between two revisions.
 */
export function matchPair(invA, anchorsA, reachA, invB, anchorsB, reachB) {
  const fromId = invA.binary.id;
  const toId = invB.binary.id;

  if (invA.binary.containerKind === 'packed-pe' || invB.binary.containerKind === 'packed-pe') {
    return {
      fromId,
      toId,
      fromVersion: invA.binary.fileVersion,
      toVersion: invB.binary.fileVersion,
      blockedByPackedBinary: true,
      summary: {
        identical: 0,
        recompiled: 0,
        modified: 0,
        added: 0,
        removed: 0,
        split: 0,
        merged: 0,
        unresolved: Math.max(reachA.reachableCount, reachB.reachableCount),
      },
      matches: [],
    };
  }

  const byVaA = new Map(invA.functions.map((f) => [f.va, f]));
  const byVaB = new Map(invB.functions.map((f) => [f.va, f]));
  const scopeA = new Set(reachA.reachableVas);
  const scopeB = new Set(reachB.reachableVas);

  const matchedA = new Map(); // vaA -> match record
  const matchedB = new Set(); // vaB

  const recordMatch = (fnA, fnB, changeClass, evidenceTier, tier, anchorId = null) => {
    if (matchedA.has(fnA.va) || matchedB.has(fnB.va)) return false;
    const rec = {
      fromVa: fnA.va,
      fromRva: fnA.rva,
      toVa: fnB.va,
      toRva: fnB.rva,
      changeClass,
      evidenceTier,
      matchTier: tier,
      ...(anchorId ? {anchorId} : {}),
      ...(changeClass === 'modified' ? {diff: buildDiffDetails(fnA, fnB)} : {}),
    };
    matchedA.set(fnA.va, rec);
    matchedB.add(fnB.va);
    return true;
  };

  // --- Tier 2A (High-priority confirmed structural anchors first) ---
  for (const [anchorId, aInfo] of Object.entries(anchorsA)) {
    const bInfo = anchorsB[anchorId];
    if (!aInfo?.va || !bInfo?.va) continue;
    // If an anchor was inlined into dispatcher.global in one revision, record explicitly as merged/split
    if (bInfo.inlinedInto && !aInfo.inlinedInto) {
      const fnA = byVaA.get(aInfo.va);
      if (fnA && !matchedA.has(fnA.va)) {
        matchedA.set(fnA.va, {
          fromVa: fnA.va,
          fromRva: fnA.rva,
          toVa: bInfo.va,
          toRva: bInfo.rva,
          changeClass: 'merged',
          evidenceTier: 'structural_correspondence',
          matchTier: 'tier2-anchor-inlined',
          anchorId,
          inlinedInto: bInfo.inlinedInto,
        });
      }
      continue;
    }
    const fnA = byVaA.get(aInfo.va);
    const fnB = byVaB.get(bInfo.va);
    if (!fnA || !fnB) continue;
    if (fnA.rawBytesSha256 === fnB.rawBytesSha256) {
      recordMatch(fnA, fnB, 'identical', 'exact_binary_identity', 'tier2-anchor+exact', anchorId);
    } else if (fnA.normalizedInsnSha256 === fnB.normalizedInsnSha256) {
      recordMatch(fnA, fnB, 'recompiled', 'probable_semantic_equivalence', 'tier2-anchor+norm', anchorId);
    } else {
      recordMatch(fnA, fnB, 'modified', 'structural_correspondence', 'tier2-anchor', anchorId);
    }
  }

  // Helper to index unmatched scope functions by hash
  const indexBy = (scopeSet, byVa, keyFn, excludedSet) => {
    const map = new Map();
    for (const va of scopeSet) {
      if (excludedSet.has(va)) continue;
      const fn = byVa.get(va);
      if (!fn) continue;
      const k = keyFn(fn);
      let arr = map.get(k);
      if (!arr) {
        arr = [];
        map.set(k, arr);
      }
      arr.push(fn);
    }
    return map;
  };

  // --- Tier 1A: Unique exact rawBytesSha256 match ---
  {
    const rawA = indexBy(scopeA, byVaA, (f) => f.rawBytesSha256, matchedA);
    const rawB = indexBy(scopeB, byVaB, (f) => f.rawBytesSha256, matchedB);
    for (const [h, listA] of rawA) {
      const listB = rawB.get(h);
      if (listA.length === 1 && listB?.length === 1) {
        recordMatch(listA[0], listB[0], 'identical', 'exact_binary_identity', 'tier1-raw-unique');
      }
    }
  }

  // --- Tier 1B: Unique constant-preserving normalizedInsnSha256 match ---
  {
    const normA = indexBy(scopeA, byVaA, (f) => f.normalizedInsnSha256, matchedA);
    const normB = indexBy(scopeB, byVaB, (f) => f.normalizedInsnSha256, matchedB);
    for (const [h, listA] of normA) {
      const listB = normB.get(h);
      if (listA.length === 1 && listB?.length === 1) {
        const fnA = listA[0];
        const fnB = listB[0];
        const isExact = fnA.rawBytesSha256 === fnB.rawBytesSha256;
        recordMatch(
          fnA,
          fnB,
          isExact ? 'identical' : 'recompiled',
          isExact ? 'exact_binary_identity' : 'probable_semantic_equivalence',
          'tier1-norm-unique',
        );
      }
    }
  }

  // --- Tier 1C: Unique cfgShapeSha256 + identical semanticConstants (min 4 blocks to avoid trivial 1-block collisions) ---
  {
    const cfgA = indexBy(scopeA, byVaA, (f) => f.cfgShapeSha256, matchedA);
    const cfgB = indexBy(scopeB, byVaB, (f) => f.cfgShapeSha256, matchedB);
    for (const [h, listA] of cfgA) {
      const listB = cfgB.get(h);
      if (listA.length === 1 && listB?.length === 1 && listA[0].blockCount >= 4) {
        const fnA = listA[0];
        const fnB = listB[0];
        const cd = constantDiff(fnA.semanticConstants, fnB.semanticConstants);
        if (cd.equal) {
          recordMatch(fnA, fnB, 'recompiled', 'probable_semantic_equivalence', 'tier1-cfg+const-unique');
        } else {
          recordMatch(fnA, fnB, 'modified', 'structural_correspondence', 'tier1-cfg-unique');
        }
      }
    }
  }

  // --- Tier 2B: Iterative call-graph neighborhood propagation from confirmed anchors/matches ---
  for (let pass = 0; pass < 4; pass++) {
    let addedInPass = 0;
    const currentMatches = [...matchedA.values()];
    for (const m of currentMatches) {
      const parentA = byVaA.get(m.fromVa);
      const parentB = byVaB.get(m.toVa);
      if (!parentA || !parentB) continue;

      const uCalleesA = parentA.callees.filter((va) => scopeA.has(va) && !matchedA.has(va)).map((va) => byVaA.get(va));
      const uCalleesB = parentB.callees.filter((va) => scopeB.has(va) && !matchedB.has(va)).map((va) => byVaB.get(va));
      if (uCalleesA.length === 0 || uCalleesB.length === 0) continue;

      // 1. Disambiguate shared normalized hash inside confirmed parent
      for (const fa of uCalleesA) {
        if (matchedA.has(fa.va)) continue;
        const sameNorm = uCalleesB.filter((fb) => !matchedB.has(fb.va) && fb.normalizedInsnSha256 === fa.normalizedInsnSha256);
        if (sameNorm.length === 1) {
          const fb = sameNorm[0];
          const isExact = fa.rawBytesSha256 === fb.rawBytesSha256;
          if (
            recordMatch(
              fa,
              fb,
              isExact ? 'identical' : 'recompiled',
              isExact ? 'exact_binary_identity' : 'probable_semantic_equivalence',
              'tier2-neighborhood-norm',
            )
          ) {
            addedInPass++;
          }
          continue;
        }
        // 2. Unique CFG shape inside confirmed parent
        const sameCfg = uCalleesB.filter((fb) => !matchedB.has(fb.va) && fb.cfgShapeSha256 === fa.cfgShapeSha256);
        if (sameCfg.length === 1 && fa.blockCount >= 2) {
          const fb = sameCfg[0];
          const cd = constantDiff(fa.semanticConstants, fb.semanticConstants);
          if (
            recordMatch(
              fa,
              fb,
              cd.equal ? 'recompiled' : 'modified',
              cd.equal ? 'probable_semantic_equivalence' : 'structural_correspondence',
              'tier2-neighborhood-cfg',
            )
          ) {
            addedInPass++;
          }
          continue;
        }
        // 3. Unique strong string xref overlap inside confirmed parent
        const strHits = uCalleesB.filter((fb) => !matchedB.has(fb.va) && stringJaccard(fa.stringXrefs, fb.stringXrefs) >= 0.7);
        if (strHits.length === 1) {
          if (recordMatch(fa, strHits[0], 'modified', 'structural_correspondence', 'tier2-neighborhood-str')) {
            addedInPass++;
          }
          continue;
        }
        // 4. Sole remaining unmatched callee of same parent with compatible size & switch count (within 40%)
        if (uCalleesA.filter((x) => !matchedA.has(x.va)).length === 1 && uCalleesB.filter((x) => !matchedB.has(x.va)).length === 1) {
          const fb = uCalleesB.find((x) => !matchedB.has(x.va));
          const ratio = Math.min(fa.byteLength, fb.byteLength) / Math.max(fa.byteLength, fb.byteLength);
          if (ratio >= 0.6 && maxSwitchCases(fa) === maxSwitchCases(fb)) {
            if (recordMatch(fa, fb, 'modified', 'structural_correspondence', 'tier2-neighborhood-sole')) {
              addedInPass++;
            }
          }
        }
      }
    }
    if (addedInPass === 0) break;
  }

  // --- Tier 2C: Unique strong string xref match across full engine scope (non-generic strings) ---
  {
    const strIndexB = new Map();
    for (const vaB of scopeB) {
      if (matchedB.has(vaB)) continue;
      const fb = byVaB.get(vaB);
      for (const s of fb.stringXrefs) {
        if (s.length < 10 || s === '無効なコマンドが指定されました。') continue;
        let arr = strIndexB.get(s);
        if (!arr) {
          arr = [];
          strIndexB.set(s, arr);
        }
        arr.push(fb);
      }
    }
    for (const vaA of scopeA) {
      if (matchedA.has(vaA)) continue;
      const fa = byVaA.get(vaA);
      const uniqueHits = new Set();
      for (const s of fa.stringXrefs) {
        if (s.length < 10 || s === '無効なコマンドが指定されました。') continue;
        const arr = strIndexB.get(s);
        if (arr && arr.length === 1 && !matchedB.has(arr[0].va)) {
          uniqueHits.add(arr[0]);
        }
      }
      if (uniqueHits.size === 1) {
        const fb = [...uniqueHits][0];
        if (stringJaccard(fa.stringXrefs, fb.stringXrefs) >= 0.5) {
          recordMatch(fa, fb, 'modified', 'structural_correspondence', 'tier2-unique-string');
        }
      }
    }
  }

  // --- Tier 3: Detect split / merged / removed / added / unresolved explicitly ---
  const matches = [...matchedA.values()];
  const mappedAtoB = new Map(matches.map((m) => [m.fromVa, m.toVa]));
  const mappedBtoA = new Map(matches.map((m) => [m.toVa, m.fromVa]));

  const unmatchedA = [...scopeA].filter((va) => !matchedA.has(va));
  const unmatchedB = [...scopeB].filter((va) => !matchedB.has(va));

  // Detect split: unmatched fn in A whose caller was matched to callerB, and callerB has >=2 unmatched callees
  // whose combined size roughly spans fnA (or vice versa for merged).
  const splitUsedB = new Set();
  const mergedUsedA = new Set();

  for (const vaA of unmatchedA) {
    const fa = byVaA.get(vaA);
    const matchedCallersB = fa.callers.map((c) => mappedAtoB.get(c)).filter(Boolean);
    if (matchedCallersB.length === 1) {
      const cb = byVaB.get(matchedCallersB[0]);
      const extraB = cb.callees.filter((c) => scopeB.has(c) && !matchedB.has(c) && !splitUsedB.has(c));
      if (extraB.length >= 2) {
        const sumB = extraB.reduce((acc, c) => acc + byVaB.get(c).byteLength, 0);
        const ratio = Math.min(fa.byteLength, sumB) / Math.max(fa.byteLength, sumB);
        if (ratio >= 0.65 && fa.byteLength >= 120) {
          for (const eb of extraB) splitUsedB.add(eb);
          matches.push({
            fromVa: fa.va,
            fromRva: fa.rva,
            toVa: null,
            toRva: null,
            splitIntoVas: extraB,
            changeClass: 'split',
            evidenceTier: 'structural_correspondence',
            matchTier: 'tier3-split-heuristic',
          });
          mergedUsedA.add(vaA);
          continue;
        }
      }
    }
  }

  for (const vaB of unmatchedB) {
    if (splitUsedB.has(vaB)) continue;
    const fb = byVaB.get(vaB);
    const matchedCallersA = fb.callers.map((c) => mappedBtoA.get(c)).filter(Boolean);
    if (matchedCallersA.length === 1) {
      const ca = byVaA.get(matchedCallersA[0]);
      const extraA = ca.callees.filter((c) => scopeA.has(c) && !matchedA.has(c) && !mergedUsedA.has(c));
      if (extraA.length >= 2) {
        const sumA = extraA.reduce((acc, c) => acc + byVaA.get(c).byteLength, 0);
        const ratio = Math.min(fb.byteLength, sumA) / Math.max(fb.byteLength, sumA);
        if (ratio >= 0.65 && fb.byteLength >= 120) {
          for (const ea of extraA) mergedUsedA.add(ea);
          splitUsedB.add(vaB);
          matches.push({
            fromVa: null,
            fromRva: null,
            mergedFromVas: extraA,
            toVa: fb.va,
            toRva: fb.rva,
            changeClass: 'merged',
            evidenceTier: 'structural_correspondence',
            matchTier: 'tier3-merged-heuristic',
          });
        }
      }
    }
  }

  // Classify remaining unmatched A as removed vs unresolved
  for (const vaA of unmatchedA) {
    if (mergedUsedA.has(vaA)) continue;
    const fa = byVaA.get(vaA);
    const allCallersMatched =
      fa.callers.length > 0 && fa.callers.filter((c) => scopeA.has(c)).every((c) => mappedAtoB.has(c));
    const callersHaveNoUnmatchedB =
      allCallersMatched &&
      fa.callers
        .filter((c) => scopeA.has(c))
        .every((c) => {
          const cb = byVaB.get(mappedAtoB.get(c));
          return cb && cb.callees.every((x) => !scopeB.has(x) || matchedB.has(x));
        });
    matches.push({
      fromVa: fa.va,
      fromRva: fa.rva,
      toVa: null,
      toRva: null,
      changeClass: callersHaveNoUnmatchedB ? 'removed' : 'unresolved',
      evidenceTier: 'unresolved',
      matchTier: callersHaveNoUnmatchedB ? 'tier3-caller-verified-removed' : 'tier3-unresolved-from',
    });
  }

  // Classify remaining unmatched B as added vs unresolved
  for (const vaB of unmatchedB) {
    if (splitUsedB.has(vaB)) continue;
    const fb = byVaB.get(vaB);
    const allCallersMatched =
      fb.callers.length > 0 && fb.callers.filter((c) => scopeB.has(c)).every((c) => mappedBtoA.has(c));
    const callersHaveNoUnmatchedA =
      allCallersMatched &&
      fb.callers
        .filter((c) => scopeB.has(c))
        .every((c) => {
          const ca = byVaA.get(mappedBtoA.get(c));
          return ca && ca.callees.every((x) => !scopeA.has(x) || matchedA.has(x));
        });
    matches.push({
      fromVa: null,
      fromRva: null,
      toVa: fb.va,
      toRva: fb.rva,
      changeClass: callersHaveNoUnmatchedA ? 'added' : 'unresolved',
      evidenceTier: 'unresolved',
      matchTier: callersHaveNoUnmatchedA ? 'tier3-caller-verified-added' : 'tier3-unresolved-to',
    });
  }

  const summary = {
    identical: 0,
    recompiled: 0,
    modified: 0,
    added: 0,
    removed: 0,
    split: 0,
    merged: 0,
    unresolved: 0,
  };
  const tierCounts = {};
  for (const m of matches) {
    summary[m.changeClass] = (summary[m.changeClass] ?? 0) + 1;
    tierCounts[m.evidenceTier] = (tierCounts[m.evidenceTier] ?? 0) + 1;
  }

  return {
    fromId,
    toId,
    fromVersion: invA.binary.fileVersion,
    toVersion: invB.binary.fileVersion,
    blockedByPackedBinary: false,
    fromReachableCount: reachA.reachableCount,
    toReachableCount: reachB.reachableCount,
    summary,
    evidenceTierCounts: tierCounts,
    matches,
  };
}

export function buildCrossVersionMap(ids, {compact = false} = {}) {
  const inventories = [];
  for (const id of ids) {
    const p = path.join(EXPORTS_DIR, `${id}.inventory.json`);
    if (!fs.existsSync(p)) {
      throw new Error(`Missing Phase 1 inventory for ${id}: ${p}`);
    }
    inventories.push(JSON.parse(fs.readFileSync(p, 'utf8')));
  }

  const revisions = inventories.map((inv) => ({
    id: inv.binary.id,
    fileVersion: inv.binary.fileVersion,
    containerKind: inv.binary.containerKind,
    sha256: inv.binary.sha256,
    analyzedSha256: inv.binary.analyzedSha256,
    discoveredFunctionCount: inv.summary.discoveredFunctionCount,
    bucketCounts: inv.summary.bucketCounts,
    totalSwitchTables: inv.summary.totalSwitchTables,
    totalIndirectCallSites: inv.summary.totalIndirectCallSites,
  }));

  const anchors = {};
  const reachability = {};
  for (const inv of inventories) {
    anchors[inv.binary.id] = discoverAnchors(inv);
    reachability[inv.binary.id] = computeReachability(inv, anchors[inv.binary.id]);
  }

  // Match consecutive unpacked revisions (and explicitly record packed revision transitions)
  const pairs = [];
  const unpacked = inventories.filter((inv) => inv.binary.containerKind !== 'packed-pe');
  for (let i = 0; i < unpacked.length - 1; i++) {
    const a = unpacked[i];
    const b = unpacked[i + 1];
    pairs.push(matchPair(a, anchors[a.binary.id], reachability[a.binary.id], b, anchors[b.binary.id], reachability[b.binary.id]));
  }
  // Also include packed -> first unpacked boundary explicitly if present
  const packed = inventories.filter((inv) => inv.binary.containerKind === 'packed-pe');
  if (packed.length > 0 && unpacked.length > 0) {
    for (const pk of packed) {
      const u0 = unpacked[0];
      pairs.unshift(matchPair(pk, anchors[pk.binary.id], reachability[pk.binary.id], u0, anchors[u0.binary.id], reachability[u0.binary.id]));
    }
  }

  const fullResult = {
    schema: MATCH_MAP_SCHEMA,
    generatedAt: new Date().toISOString(),
    revisions,
    anchors,
    reachability: compact
      ? Object.fromEntries(
          Object.entries(reachability).map(([k, v]) => {
            const {reachableVas: _omit, ...rest} = v;
            return [k, rest];
          }),
        )
      : reachability,
    pairs: compact
      ? pairs.map((p) => ({
          ...p,
          // Keep full summary + anchor/modified/split/merged/added/removed highlights in compact committed report
          matches: p.matches.filter((m) => m.anchorId || m.changeClass === 'modified').slice(0, 250),
        }))
      : pairs,
  };

  const validation = validateMatchMap(fullResult);
  if (!validation.valid) {
    throw new Error(`Match map schema validation failed:\n  ${validation.errors.join('\n  ')}`);
  }
  return fullResult;
}

function parseCli(argv) {
  const opts = {ids: null, all: false, out: null, compactOut: null};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--all') opts.all = true;
    else if (a === '--ids') opts.ids = argv[++i].split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--out') opts.out = path.resolve(argv[++i]);
    else if (a === '--compact-out') opts.compactOut = path.resolve(argv[++i]);
    else throw new Error(`Unknown argument: ${a}`);
  }
  return opts;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const opts = parseCli(process.argv.slice(2));
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  const ids = opts.all ? corpus.binaries.map((b) => b.id) : opts.ids;
  if (!ids || ids.length < 2) {
    console.error('Usage: node tools/siglus-inventory/match.mjs [--all | --ids a,b,...] [--out <full.json>] [--compact-out <compact.json>]');
    process.exit(1);
  }

  const full = buildCrossVersionMap(ids, {compact: false});
  const outPath = opts.out ?? path.join(CHECKPOINTS_DIR, `match-${ids.length}rev.json`);
  fs.mkdirSync(path.dirname(outPath), {recursive: true});
  fs.writeFileSync(outPath, JSON.stringify(full, null, 2) + '\n');
  console.log(`[ok] Wrote full cross-version map to ${path.relative(REPO_ROOT, outPath)}`);

  if (opts.compactOut) {
    const compact = buildCrossVersionMap(ids, {compact: true});
    fs.mkdirSync(path.dirname(opts.compactOut), {recursive: true});
    fs.writeFileSync(opts.compactOut, JSON.stringify(compact, null, 2) + '\n');
    console.log(`[ok] Wrote compact cross-version report to ${path.relative(REPO_ROOT, opts.compactOut)}`);
  }

  for (const rev of full.revisions) {
    const r = full.reachability[rev.id];
    const anchoredCount = Object.values(full.anchors[rev.id]).filter((a) => a.status === 'anchored').length;
    const totalAnchors = Object.keys(full.anchors[rev.id]).length;
    console.log(
      `  rev ${rev.id.padEnd(15)} (${(rev.fileVersion ?? 'unknown').padEnd(9)}): ` +
        `discovered=${rev.discoveredFunctionCount}, anchors=${anchoredCount}/${totalAnchors}, ` +
        `reachable>=${r.reachableCount}, indirectFrontier=${r.indirectCallFrontierCount} fns (${r.indirectCallSiteCount} sites)`,
    );
  }
  for (const p of full.pairs) {
    console.log(
      `  pair ${p.fromId} (${p.fromVersion}) -> ${p.toId} (${p.toVersion}): ` +
        JSON.stringify(p.summary) +
        (p.blockedByPackedBinary ? ' [PACKED_BLOCKER]' : ''),
    );
  }
}
