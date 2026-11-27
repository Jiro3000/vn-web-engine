import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  INVENTORY_SCHEMA,
  LEDGER_SCHEMA,
  validateInventory,
  validateMatchMap,
  validateVerificationLedger,
} from '../tools/siglus-inventory/schema.mjs';
import {
  computeReachability,
  discoverAnchors,
  matchPair,
} from '../tools/siglus-inventory/match.mjs';
import {checkLedger, evaluateStaleness, hashSourceRegion} from '../tools/siglus-inventory/ledger.mjs';
import {runSingleMutant} from '../tools/siglus-mutate.mjs';

const H_A = 'a'.repeat(64);
const H_B = 'b'.repeat(64);
const H_C = 'c'.repeat(64);
const H_D = 'd'.repeat(64);

function makeSynthFn(overrides = {}) {
  return {
    rva: '0x1000',
    va: '0x401000',
    name: 'FUN_00401000',
    isThunk: false,
    bucket: 'engine_candidate',
    bodyRanges: [{start: '0x401000', end: '0x40103f', byteLength: 64}],
    byteLength: 64,
    insnCount: 20,
    blockCount: 5,
    rawBytesSha256: H_A,
    normalizedInsnSha256: H_B,
    cfgShapeSha256: H_C,
    semanticConstants: [10, 20, 42],
    callers: [],
    callees: [],
    indirectCallSites: [],
    stringXrefs: [],
    importXrefs: [],
    ...overrides,
  };
}

function makeSynthInventory(id, fileVersion, functions, containerKind = 'direct-pe') {
  return {
    schema: INVENTORY_SCHEMA,
    capturedAt: '2026-11-27T00:00:00Z',
    exporter: {name: 'SiglusWholeBinaryInventory', version: '1.0.0', ghidraVersion: '12.1.4'},
    binary: {
      id,
      programPath: '/SiglusEngine.exe',
      sha256: H_A,
      analyzedSha256: H_A,
      fileVersion,
      containerKind,
      embeddedPeOffset: null,
      imageBase: '0x400000',
      size: 1024 * 1024,
      languageId: 'x86:LE:32:default',
      compilerSpecId: 'windows',
      sections: [],
    },
    functions,
    summary: {
      discoveredFunctionCount: functions.length,
      exportedFunctionCount: functions.length,
      totalIndirectCallSites: functions.reduce((a, f) => a + f.indirectCallSites.length, 0),
      totalSwitchTables: functions.reduce((a, f) => a + (f.switchTableInfo?.length ?? 0), 0),
      bucketCounts: {engine_candidate: functions.length},
    },
  };
}

test('Phase 1 schema validator accepts well-formed inventory and rejects corruption', () => {
  const valid = makeSynthInventory('synth-a', '1.1.80.8', [makeSynthFn()]);
  assert.deepEqual(validateInventory(valid), {valid: true, errors: []});

  const badLen = makeSynthInventory('synth-a', '1.1.80.8', [makeSynthFn({byteLength: 999})]);
  assert.equal(validateInventory(badLen).valid, false);

  const dupRva = makeSynthInventory('synth-a', '1.1.80.8', [makeSynthFn(), makeSynthFn()]);
  assert.equal(validateInventory(dupRva).valid, false);

  const badBucket = makeSynthInventory('synth-a', '1.1.80.8', [makeSynthFn({bucket: 'magic_guess'})]);
  assert.equal(validateInventory(badBucket).valid, false);
});

test('Phase 2 matcher preserves semantic constants, distinguishes evidence tiers, and records indirect frontier', () => {
  const invA = makeSynthInventory('rev-a', '1.1.80.8', [
    makeSynthFn({
      rva: '0x1000',
      va: '0x401000',
      rawBytesSha256: '1'.repeat(64),
      normalizedInsnSha256: '2'.repeat(64),
      cfgShapeSha256: '3'.repeat(64),
      callees: ['0x402000', '0x403000', '0x404000', '0x405000'],
      stringXrefs: ['無効なコマンドが指定されました。(global)'],
      switchTableInfo: [{jumpVa: '0x401020', caseCount: 150, uniqueTargetCount: 150}],
      indirectCallSites: [{siteVa: '0x401030', mnemonic: 'CALL', kind: 'indirect-call', operand: 'EAX'}],
    }),
    // Exact identical child
    makeSynthFn({
      rva: '0x2000',
      va: '0x402000',
      rawBytesSha256: '4'.repeat(64),
      normalizedInsnSha256: '5'.repeat(64),
      cfgShapeSha256: '6'.repeat(64),
      callers: ['0x401000'],
    }),
    // Recompiled child (different raw bytes, same constant-preserving normalized hash)
    makeSynthFn({
      rva: '0x3000',
      va: '0x403000',
      rawBytesSha256: '7'.repeat(64),
      normalizedInsnSha256: '8'.repeat(64),
      cfgShapeSha256: '9'.repeat(64),
      callers: ['0x401000'],
    }),
    // Modified child (same CFG shape, DIFFERENT semantic constant -> must NOT be classified as recompiled!)
    makeSynthFn({
      rva: '0x4000',
      va: '0x404000',
      rawBytesSha256: 'a'.repeat(64),
      normalizedInsnSha256: 'b'.repeat(64),
      cfgShapeSha256: 'c'.repeat(64),
      semanticConstants: [100, 200],
      callers: ['0x401000'],
    }),
    // CRT boundary must stop transitive reachability
    makeSynthFn({
      rva: '0x5000',
      va: '0x405000',
      bucket: 'crt_stl',
      callers: ['0x401000'],
      callees: ['0x406000'],
    }),
    makeSynthFn({
      rva: '0x6000',
      va: '0x406000',
      callers: ['0x405000'],
    }),
  ]);

  const invB = makeSynthInventory('rev-b', '1.1.141.3', [
    makeSynthFn({
      rva: '0x1100',
      va: '0x401100',
      rawBytesSha256: 'd'.repeat(64),
      normalizedInsnSha256: 'e'.repeat(64),
      cfgShapeSha256: 'f'.repeat(64),
      callees: ['0x402100', '0x403100', '0x404100'],
      stringXrefs: ['無効なコマンドが指定されました。(global)'],
      switchTableInfo: [{jumpVa: '0x401120', caseCount: 155, uniqueTargetCount: 155}],
    }),
    makeSynthFn({
      rva: '0x2100',
      va: '0x402100',
      rawBytesSha256: '4'.repeat(64),
      normalizedInsnSha256: '5'.repeat(64),
      cfgShapeSha256: '6'.repeat(64),
      callers: ['0x401100'],
    }),
    makeSynthFn({
      rva: '0x3100',
      va: '0x403100',
      rawBytesSha256: '0'.repeat(64),
      normalizedInsnSha256: '8'.repeat(64),
      cfgShapeSha256: '9'.repeat(64),
      callers: ['0x401100'],
    }),
    makeSynthFn({
      rva: '0x4100',
      va: '0x404100',
      rawBytesSha256: '1'.repeat(64),
      normalizedInsnSha256: '0'.repeat(64),
      cfgShapeSha256: 'c'.repeat(64),
      semanticConstants: [100, 250], // constant changed 200 -> 250!
      callers: ['0x401100'],
    }),
  ]);

  const anchorsA = discoverAnchors(invA);
  const anchorsB = discoverAnchors(invB);
  assert.equal(anchorsA['dispatcher.global'].va, '0x401000');
  assert.equal(anchorsB['dispatcher.global'].va, '0x401100');

  const reachA = computeReachability(invA, anchorsA);
  const reachB = computeReachability(invB, anchorsB);
  assert.equal(reachA.isLowerBound, true);
  // Stops at CRT boundary 0x405000; never reaches 0x406000
  assert.equal(reachA.reachableCount, 4);
  assert.equal(reachA.boundaryStoppedCounts.crt_stl, 1);
  assert.equal(reachA.indirectCallFrontierCount, 1);
  assert.equal(reachA.indirectCallSiteCount, 1);

  const pair = matchPair(invA, anchorsA, reachA, invB, anchorsB, reachB);
  const byFrom = new Map(pair.matches.filter((m) => m.fromVa).map((m) => [m.fromVa, m]));
  assert.equal(byFrom.get('0x401000').changeClass, 'modified');
  assert.equal(byFrom.get('0x401000').evidenceTier, 'structural_correspondence');
  assert.equal(byFrom.get('0x402000').changeClass, 'identical');
  assert.equal(byFrom.get('0x402000').evidenceTier, 'exact_binary_identity');
  assert.equal(byFrom.get('0x403000').changeClass, 'recompiled');
  assert.equal(byFrom.get('0x403000').evidenceTier, 'probable_semantic_equivalence');
  // Constant change MUST produce modified + structural_correspondence, never recompiled!
  assert.equal(byFrom.get('0x404000').changeClass, 'modified');
  assert.equal(byFrom.get('0x404000').evidenceTier, 'structural_correspondence');
  assert.deepEqual(byFrom.get('0x404000').diff.addedConstants, [250]);
  assert.deepEqual(byFrom.get('0x404000').diff.removedConstants, [200]);

  assert.equal(
    validateMatchMap({
      schema: 'siglus-cross-version-map/v1',
      revisions: [invA.binary, invB.binary],
      anchors: {'rev-a': anchorsA, 'rev-b': anchorsB},
      reachability: {'rev-a': reachA, 'rev-b': reachB},
      pairs: [pair],
    }).valid,
    true,
  );
});

test('Phase 2 explicitly flags packed binaries without fabricating matches', () => {
  const packed = makeSynthInventory('packed-rev', '1.1.80.7', [makeSynthFn()], 'packed-pe');
  const unpacked = makeSynthInventory('unpacked-rev', '1.1.80.8', [makeSynthFn()], 'direct-pe');
  const aP = discoverAnchors(packed);
  const rP = computeReachability(packed, aP);
  assert.equal(aP['dispatcher.global'].status, 'packed_binary_blocker');
  assert.equal(rP.packedBlocker, true);
  assert.equal(rP.reachableCount, 0);
  const pair = matchPair(packed, aP, rP, unpacked, discoverAnchors(unpacked), computeReachability(unpacked, discoverAnchors(unpacked)));
  assert.equal(pair.blockedByPackedBinary, true);
  assert.deepEqual(pair.matches, []);
});

test('Phase 3 ledger rejects unpinned statically_verified claims and detects staleness on TS, dependency, or binary changes', () => {
  const baseStatus = {
    discovered: true,
    cross_version_matched: true,
    understood: true,
    implemented: true,
    statically_verified: true,
    unit_tested: true,
    interaction_tested: false,
    mutation_tested: false,
    browser_verified: false,
  };

  // Unpinned statically_verified MUST be rejected
  const unpinnedLedger = {
    schema: LEDGER_SCHEMA,
    generatedAt: '2026-11-27T00:00:00Z',
    binaries: {anemoi: {analyzedSha256: H_A}},
    sourcePins: {'src/engines/siglus/player.ts': H_B},
    entries: [
      {
        id: 'cmd:64.51',
        kind: 'command',
        status: {...baseStatus},
        stale: false,
        staleReasons: [],
        tsLinks: [{file: 'src/engines/siglus/player.ts'}],
        testLinks: [],
        nativeEvidence: [],
      },
    ],
    unresolvedGaps: [],
    knownDiscrepancies: [],
  };
  assert.equal(validateVerificationLedger(unpinnedLedger).valid, false);

  // Pinned entry passes validation
  const pinnedEntry = {
    id: 'cmd:64.51',
    kind: 'command',
    status: {...baseStatus},
    stale: false,
    staleReasons: [],
    tsLinks: [{file: 'src/engines/siglus/player.ts'}],
    testLinks: [],
    nativeEvidence: [{binaryId: 'anemoi', va: '0x5631d0', rawBytesSha256: H_C}],
    verifiedSnapshot: {
      sourceHashes: {'src/engines/siglus/player.ts': H_B},
      dependencyHashes: {'src/engines/siglus/vm.ts': H_D},
      binaryHashes: {anemoi: H_A},
    },
  };
  const validLedger = {...unpinnedLedger, entries: [pinnedEntry]};
  assert.equal(validateVerificationLedger(validLedger).valid, true);

  // Fresh check: not stale
  assert.deepEqual(
    evaluateStaleness(
      pinnedEntry,
      {'src/engines/siglus/player.ts': H_B, 'src/engines/siglus/vm.ts': H_D},
      {anemoi: {analyzedSha256: H_A}},
    ),
    {stale: false, staleReasons: []},
  );

  // Source TS edit -> stale!
  const srcStale = evaluateStaleness(
    pinnedEntry,
    {'src/engines/siglus/player.ts': '9'.repeat(64), 'src/engines/siglus/vm.ts': H_D},
    {anemoi: {analyzedSha256: H_A}},
  );
  assert.equal(srcStale.stale, true);
  assert.ok(srcStale.staleReasons[0].startsWith('source-changed:src/engines/siglus/player.ts'));

  // Dependency edit -> stale!
  const depStale = evaluateStaleness(
    pinnedEntry,
    {'src/engines/siglus/player.ts': H_B, 'src/engines/siglus/vm.ts': '8'.repeat(64)},
    {anemoi: {analyzedSha256: H_A}},
  );
  assert.equal(depStale.stale, true);
  assert.ok(depStale.staleReasons[0].startsWith('dependency-changed:src/engines/siglus/vm.ts'));

  // Binary identity change -> stale!
  const binStale = evaluateStaleness(
    pinnedEntry,
    {'src/engines/siglus/player.ts': H_B, 'src/engines/siglus/vm.ts': H_D},
    {anemoi: {analyzedSha256: '7'.repeat(64)}},
  );
  assert.equal(binStale.stale, true);
  assert.ok(binStale.staleReasons[0].startsWith('binary-changed:anemoi'));

  // Stale entry CANNOT remain statically_verified=true
  const illegalStale = {
    ...validLedger,
    entries: [{...pinnedEntry, stale: true, staleReasons: ['source-changed:src/engines/siglus/player.ts']}],
  };
  assert.equal(validateVerificationLedger(illegalStale).valid, false);

  // checkLedger catches dangling TS reference & stale uninvalidated file on disk
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'siglus-ledger-test-'));
  try {
    const tmpPath = path.join(tmpDir, 'ledger.json');
    fs.writeFileSync(
      tmpPath,
      JSON.stringify({
        ...validLedger,
        entries: [{...pinnedEntry, tsLinks: [{file: 'src/engines/siglus/does-not-exist.ts'}]}],
      }),
    );
    const res = checkLedger(tmpPath);
    assert.equal(res.valid, false);
    assert.ok(res.errors.some((e) => e.includes('Dangling tsLink')));
  } finally {
    fs.rmSync(tmpDir, {recursive: true, force: true});
  }
});

test('Phase 4 mutation runner classifies syntax/compilation failures as invalid, never killed', () => {
  const res = runSingleMutant(
    {
      id: 'synth.compile-error',
      file: 'src/engines/siglus/wipe.ts',
      target: 'export function wipeSoftness(option: number): number {',
      replacement: 'export function wipeSoftness(option: number): number { {{{ BROKEN SYNTAX',
    },
    os.tmpdir(),
  );
  assert.equal(res.status, 'invalid');
  assert.match(res.reason, /Compilation error/);
});

test('Phase 3 region-scoped staleness invalidates only the edited handler region and validates verificationDepth/classification', () => {
  const srcV1 = '// regionA\nfunction a() { return 1; }\n// endA\n// regionB\nfunction b() { return 2; }\n// endB\n';
  const srcV2 = '// regionA\nfunction a() { return 999; }\n// endA\n// regionB\nfunction b() { return 2; }\n// endB\n';
  const shaA = hashSourceRegion(srcV1, '// regionA', '// endA');
  const shaB = hashSourceRegion(srcV1, '// regionB', '// endB');
  assert.ok(shaA && shaB && shaA !== shaB);

  const entryA = {
    verifiedSnapshot: {sourceRegions: [{file: 'mock.ts', startMarker: '// regionA', endMarker: '// endA', sha256: shaA}]},
  };
  const entryB = {
    verifiedSnapshot: {sourceRegions: [{file: 'mock.ts', startMarker: '// regionB', endMarker: '// endB', sha256: shaB}]},
  };
  assert.equal(evaluateStaleness(entryA, {}, {}, {'mock.ts': srcV1}).stale, false);
  assert.equal(evaluateStaleness(entryB, {}, {}, {'mock.ts': srcV1}).stale, false);
  // Editing regionA invalidates ONLY entryA, leaving entryB fresh!
  assert.equal(evaluateStaleness(entryA, {}, {}, {'mock.ts': srcV2}).stale, true);
  assert.equal(evaluateStaleness(entryB, {}, {}, {'mock.ts': srcV2}).stale, false);
});
