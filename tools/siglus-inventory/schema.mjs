/**
 * Strict schema validators for SiglusEngine native inventory, cross-version
 * matching, and multi-layer verification ledger artifacts.
 *
 * Pure Node built-ins; zero external dependencies.
 */

export const INVENTORY_SCHEMA = 'siglus-native-inventory/v1';
export const MATCH_MAP_SCHEMA = 'siglus-cross-version-map/v1';
export const LEDGER_SCHEMA = 'siglus-verification-ledger/v1';

const SHA256_RE = /^[0-9a-f]{64}$/;
const HEX_ADDR_RE = /^0x(?:0|[1-9a-f][0-9a-f]*)$/;

export const FUNCTION_BUCKETS = new Set([
  'engine_candidate',
  'thunk',
  'crt_stl',
  'win32_directx_wrapper',
  'third_party_codec',
  'unclassified',
]);

export const MATCH_EVIDENCE_TIERS = new Set([
  'exact_binary_identity',
  'structural_correspondence',
  'probable_semantic_equivalence',
  'proven_semantic_equivalence',
  'unresolved',
]);

export const VERSION_CHANGE_CLASSES = new Set([
  'identical',
  'recompiled',
  'modified',
  'added',
  'removed',
  'split',
  'merged',
  'unresolved',
]);

export const VERIFICATION_METRIC_KEYS = [
  'discovered',
  'cross_version_matched',
  'understood',
  'implemented',
  'statically_verified',
  'unit_tested',
  'interaction_tested',
  'mutation_tested',
  'browser_verified',
];

export const VERIFICATION_DEPTHS = new Set([
  'unverified',
  'wrapper_dispatch',
  'leaf_verified',
  'platform_boundary',
]);

export const ENTRY_CLASSIFICATIONS = new Set([
  'engine_semantic',
  'platform_boundary',
  'packed_binary_blocker',
]);

function isObj(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function isNonEmptyStr(v) {
  return typeof v === 'string' && v.length > 0;
}

export function isHexAddr(v) {
  return typeof v === 'string' && HEX_ADDR_RE.test(v);
}

export function isSha256(v) {
  return typeof v === 'string' && SHA256_RE.test(v);
}

/**
 * Validate a Phase 1 whole-binary inventory JSON object.
 * Returns `{valid: boolean, errors: string[]}`.
 */
export function validateInventory(inv) {
  const errors = [];
  const check = (cond, msg) => {
    if (!cond) errors.push(msg);
  };

  if (!isObj(inv)) return {valid: false, errors: ['Inventory root must be an object']};
  check(inv.schema === INVENTORY_SCHEMA, `schema must be ${INVENTORY_SCHEMA}, got ${inv.schema}`);
  check(isNonEmptyStr(inv.capturedAt), 'capturedAt must be a non-empty ISO string');
  check(isObj(inv.exporter) && isNonEmptyStr(inv.exporter.ghidraVersion), 'exporter.ghidraVersion required');

  const bin = inv.binary;
  check(isObj(bin), 'binary object required');
  if (isObj(bin)) {
    check(isNonEmptyStr(bin.id), 'binary.id required');
    check(isSha256(bin.sha256), `binary.sha256 invalid: ${bin.sha256}`);
    check(isSha256(bin.analyzedSha256), `binary.analyzedSha256 invalid: ${bin.analyzedSha256}`);
    check(bin.fileVersion === null || isNonEmptyStr(bin.fileVersion), 'binary.fileVersion must be string or null');
    check(isHexAddr(bin.imageBase), `binary.imageBase invalid: ${bin.imageBase}`);
    check(Number.isSafeInteger(bin.size) && bin.size > 0, `binary.size invalid: ${bin.size}`);
    check(isNonEmptyStr(bin.languageId), 'binary.languageId required');
    check(
      ['direct-pe', 'sdwrap-embedded-pe', 'packed-pe'].includes(bin.containerKind),
      `binary.containerKind invalid: ${bin.containerKind}`,
    );
  }

  check(isObj(inv.summary), 'summary required');
  check(Array.isArray(inv.functions), 'functions array required');

  if (Array.isArray(inv.functions)) {
    const seenRvas = new Set();
    let bucketCounts = {};
    for (let i = 0; i < inv.functions.length; i++) {
      const fn = inv.functions[i];
      const prefix = `functions[${i}]`;
      if (!isObj(fn)) {
        errors.push(`${prefix} must be an object`);
        continue;
      }
      if (!isHexAddr(fn.rva)) errors.push(`${prefix}.rva invalid: ${fn.rva}`);
      if (!isHexAddr(fn.va)) errors.push(`${prefix}.va invalid: ${fn.va}`);
      if (seenRvas.has(fn.rva)) errors.push(`Duplicate rva ${fn.rva}`);
      seenRvas.add(fn.rva);

      if (!Array.isArray(fn.bodyRanges) || fn.bodyRanges.length === 0) {
        errors.push(`${prefix}.bodyRanges must be non-empty array`);
      } else {
        let sum = 0;
        for (const r of fn.bodyRanges) {
          if (!isObj(r) || !isHexAddr(r.start) || !isHexAddr(r.end) || !Number.isSafeInteger(r.byteLength) || r.byteLength <= 0) {
            errors.push(`${prefix}.bodyRanges has invalid range`);
            break;
          }
          sum += r.byteLength;
        }
        if (sum !== fn.byteLength) {
          errors.push(`${prefix}.byteLength (${fn.byteLength}) != sum of bodyRanges (${sum})`);
        }
      }
      if (!Number.isSafeInteger(fn.byteLength) || fn.byteLength <= 0) {
        errors.push(`${prefix}.byteLength invalid`);
      }
      if (!isSha256(fn.rawBytesSha256)) errors.push(`${prefix}.rawBytesSha256 invalid`);
      if (!isSha256(fn.normalizedInsnSha256)) errors.push(`${prefix}.normalizedInsnSha256 invalid`);
      if (!isSha256(fn.cfgShapeSha256)) errors.push(`${prefix}.cfgShapeSha256 invalid`);
      if (!Array.isArray(fn.callers)) errors.push(`${prefix}.callers must be array`);
      if (!Array.isArray(fn.callees)) errors.push(`${prefix}.callees must be array`);
      if (!Array.isArray(fn.indirectCallSites)) errors.push(`${prefix}.indirectCallSites must be array`);
      if (!Array.isArray(fn.stringXrefs)) errors.push(`${prefix}.stringXrefs must be array`);
      if (!Array.isArray(fn.importXrefs)) errors.push(`${prefix}.importXrefs must be array`);
      if (!FUNCTION_BUCKETS.has(fn.bucket)) errors.push(`${prefix}.bucket invalid: ${fn.bucket}`);
      bucketCounts[fn.bucket] = (bucketCounts[fn.bucket] ?? 0) + 1;

      if (errors.length > 50) {
        errors.push('...truncated validation errors (>50)');
        break;
      }
    }
    if (isObj(inv.summary)) {
      check(
        inv.summary.discoveredFunctionCount === inv.functions.length,
        `summary.discoveredFunctionCount (${inv.summary.discoveredFunctionCount}) != functions.length (${inv.functions.length})`,
      );
      check(
        inv.summary.exportedFunctionCount === inv.functions.length,
        `summary.exportedFunctionCount (${inv.summary.exportedFunctionCount}) != functions.length (${inv.functions.length})`,
      );
    }
  }

  return {valid: errors.length === 0, errors};
}

/**
 * Validate a Phase 2 cross-version match map object.
 */
export function validateMatchMap(map) {
  const errors = [];
  const check = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  if (!isObj(map)) return {valid: false, errors: ['Match map root must be an object']};
  check(map.schema === MATCH_MAP_SCHEMA, `schema must be ${MATCH_MAP_SCHEMA}`);
  check(Array.isArray(map.revisions) && map.revisions.length >= 2, 'revisions must have >= 2 entries');
  check(isObj(map.anchors), 'anchors object required');
  check(Array.isArray(map.pairs), 'pairs array required');
  check(isObj(map.reachability), 'reachability object required');

  if (Array.isArray(map.pairs)) {
    for (let i = 0; i < map.pairs.length; i++) {
      const p = map.pairs[i];
      if (!isObj(p)) {
        errors.push(`pairs[${i}] must be object`);
        continue;
      }
      check(isNonEmptyStr(p.fromId) && isNonEmptyStr(p.toId), `pairs[${i}] missing fromId/toId`);
      check(Array.isArray(p.matches), `pairs[${i}].matches must be array`);
      if (Array.isArray(p.matches)) {
        for (let j = 0; j < p.matches.length; j++) {
          const m = p.matches[j];
          if (!VERSION_CHANGE_CLASSES.has(m.changeClass)) {
            errors.push(`pairs[${i}].matches[${j}].changeClass invalid: ${m.changeClass}`);
          }
          if (!MATCH_EVIDENCE_TIERS.has(m.evidenceTier)) {
            errors.push(`pairs[${i}].matches[${j}].evidenceTier invalid: ${m.evidenceTier}`);
          }
          if (errors.length > 50) break;
        }
      }
    }
  }
  return {valid: errors.length === 0, errors};
}

/**
 * Validate a Phase 3 multi-layer verification ledger.
 */
export function validateVerificationLedger(ledger) {
  const errors = [];
  const check = (cond, msg) => {
    if (!cond) errors.push(msg);
  };
  if (!isObj(ledger)) return {valid: false, errors: ['Ledger root must be an object']};
  check(ledger.schema === LEDGER_SCHEMA, `schema must be ${LEDGER_SCHEMA}`);
  check(isNonEmptyStr(ledger.generatedAt), 'generatedAt required');
  check(isObj(ledger.binaries), 'binaries map required');
  check(isObj(ledger.sourcePins), 'sourcePins map required');
  check(Array.isArray(ledger.entries), 'entries array required');
  check(Array.isArray(ledger.unresolvedGaps), 'unresolvedGaps array required');
  check(Array.isArray(ledger.knownDiscrepancies), 'knownDiscrepancies array required');

  if (Array.isArray(ledger.entries)) {
    const ids = new Set();
    for (let i = 0; i < ledger.entries.length; i++) {
      const e = ledger.entries[i];
      const prefix = `entries[${i}]`;
      if (!isObj(e)) {
        errors.push(`${prefix} must be object`);
        continue;
      }
      check(isNonEmptyStr(e.id), `${prefix}.id required`);
      if (ids.has(e.id)) errors.push(`Duplicate ledger entry id: ${e.id}`);
      ids.add(e.id);
      check(
        ['command', 'property', 'gameexe_key', 'native_function', 'asset_decoder'].includes(e.kind),
        `${prefix}.kind invalid: ${e.kind}`,
      );
      check(isObj(e.status), `${prefix}.status required`);
      if (isObj(e.status)) {
        for (const k of VERIFICATION_METRIC_KEYS) {
          if (typeof e.status[k] !== 'boolean') {
            errors.push(`${prefix}.status.${k} must be boolean`);
          }
        }
        // Anti-overclaiming invariant: statically_verified requires pinned native evidence
        if (e.status.statically_verified) {
          const hasPin =
            Array.isArray(e.nativeEvidence) &&
            e.nativeEvidence.some(
              (ev) =>
                isObj(ev) &&
                isNonEmptyStr(ev.binaryId) &&
                isHexAddr(ev.va) &&
                isSha256(ev.rawBytesSha256),
            );
          if (!hasPin) {
            errors.push(`${prefix} claims statically_verified=true without pinned nativeEvidence (binaryId, va, rawBytesSha256)`);
          }
        }
      }
      check(typeof e.stale === 'boolean', `${prefix}.stale must be boolean`);
      check(Array.isArray(e.staleReasons), `${prefix}.staleReasons must be array`);
      if (e.stale && e.status?.statically_verified) {
        errors.push(`${prefix} cannot remain statically_verified=true while stale=true`);
      }
      if (e.verificationDepth !== undefined && !VERIFICATION_DEPTHS.has(e.verificationDepth)) {
        errors.push(`${prefix}.verificationDepth invalid: ${e.verificationDepth}`);
      }
      if (e.classification !== undefined && !ENTRY_CLASSIFICATIONS.has(e.classification)) {
        errors.push(`${prefix}.classification invalid: ${e.classification}`);
      }
      check(Array.isArray(e.tsLinks), `${prefix}.tsLinks must be array`);
      check(Array.isArray(e.testLinks), `${prefix}.testLinks must be array`);
      if (errors.length > 60) {
        errors.push('...truncated validation errors (>60)');
        break;
      }
    }
  }
  return {valid: errors.length === 0, errors};
}
