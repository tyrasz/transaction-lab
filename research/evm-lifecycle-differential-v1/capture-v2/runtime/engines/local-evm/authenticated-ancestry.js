import { isDeepStrictEqual } from 'node:util';
import { verifyEthereumHeader } from './ethereum-header.js';
import { decode, encode } from './isolated-protocol.js';

const ZERO = '0x' + '00'.repeat(32);
export class AncestryError extends Error {
  constructor() { super('The requested block hash was not authenticated by the selected header ancestry.'); this.name = 'AncestryError'; this.code = 'LOCAL_ANCESTRY_INVALID'; }
}
const need = condition => { if (!condition) throw new AncestryError(); };

/** Hash commitments only: this verifies execution-header ancestry, not consensus,
 * finality, bodies or the source header's external chain identity. No number RPC
 * is used. N-1 is already committed by the source header; N-256 needs at most
 * 255 intermediate headers. Call/byte/time budgets belong to the collector. */
export function createAuthenticatedAncestry(header) {
  const source = decode(encode(header, 128 * 1024), 128 * 1024);
  const anchor = verifyEthereumHeader({ header: source, expectedHash: source.hash });
  const height = BigInt(anchor.number), known = new Map(), headers = [], lookups = new Map();
  let frontier = anchor;
  if (height > 0n) known.set((height - 1n).toString(), anchor.parentHash);
  function number(value) { need(typeof value === 'bigint' && value >= 0n && value < (1n << 256n)); return value; }
  function peek(value) {
    const n = number(value);
    if (n >= height || height - n > 256n) return ZERO;
    return known.get(n.toString()) ?? null;
  }
  return Object.freeze({
    peek,
    nextHash() { return headers.length < 255 && BigInt(frontier.number) > 0n ? frontier.parentHash : null; },
    accept(result, evidenceId) {
      need(Number.isSafeInteger(evidenceId) && evidenceId > 0 && (headers.length === 0 || evidenceId > headers.at(-1).evidenceId));
      need(headers.length < 255 && BigInt(frontier.number) > 0n);
      const copy = decode(encode(result, 128 * 1024), 128 * 1024);
      const verified = verifyEthereumHeader({ header: copy, expectedHash: frontier.parentHash });
      need(BigInt(verified.number) === BigInt(frontier.number) - 1n);
      need(BigInt(verified.timestamp) < BigInt(frontier.timestamp));
      headers.push({ evidenceId, ...verified }); frontier = verified;
      if (BigInt(frontier.number) > 0n) known.set((BigInt(frontier.number) - 1n).toString(), frontier.parentHash);
    },
    record(value) {
      const n = number(value), hash = peek(n); need(hash !== null);
      // Out-of-range zero needs no ancestry evidence or retained lookup row.
      if (n < height && height - n <= 256n) lookups.set(n.toString(), hash);
      return hash;
    },
    snapshot() { return { basis: 'execution_header_parent_hash_chain', anchorBlockHash: anchor.blockHash,
      anchorNumber: anchor.number, maxAncestors: 256, consensusVerified: false, finalityVerified: false,
      headers: structuredClone(headers), lookups: [...lookups].map(([number, hash]) => ({ number, hash })) }; },
  });
}

/** Rebuild claimed ancestry solely from the actual joined input RPC evidence.
 * Used by the parent for full snapshots and the original-execution prefix. */
export function validateAncestryEvidence(header, snapshot, evidence) {
  const rows = evidence.filter(row => row.request.method === 'eth_getBlockByHash');
  if (snapshot === undefined) { need(rows.length === 0); return; }
  const cursor = createAuthenticatedAncestry(header);
  for (const row of rows) {
    need(isDeepStrictEqual(row.request.params, [cursor.nextHash(), false]));
    if (row.status === 'received' && row.verification === 'verified') {
      need(Object.hasOwn(row, 'result')); cursor.accept(row.result, row.id);
    } else need(row.status === 'unavailable' || row.verification === 'rejected');
  }
  need(Array.isArray(snapshot.lookups) && snapshot.lookups.length <= 256);
  for (const row of snapshot.lookups) {
    need(typeof row.number === 'string' && /^(0|[1-9][0-9]*)$/.test(row.number) && row.number.length <= 78);
    need(cursor.record(BigInt(row.number)) === row.hash);
  }
  need(isDeepStrictEqual(cursor.snapshot(), snapshot));
}
