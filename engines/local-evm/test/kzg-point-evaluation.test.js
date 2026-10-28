import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { bls12_381 as bls } from '@noble/curves/bls12-381.js';
import { KzgInputError, KZG_POINT_EVALUATION_SETUP, verifyKzgProof } from '../kzg-point-evaluation.js';

const directory = new URL('./fixtures/kzg-point-evaluation/', import.meta.url);
const provenanceBytes = await readFile(new URL('provenance.json', directory));
const provenance = JSON.parse(provenanceBytes);
const sha = value => createHash('sha256').update(value).digest('hex');
const word = n => '0x' + n.toString(16).padStart(64, '0');
const zero = word(0n), one = word(1n);
const infinity = '0xc0' + '00'.repeat(47);
const generator = '0x' + Buffer.from(bls.G1.Point.BASE.toBytes(true)).toString('hex');
const vectorRecords = provenance.files.filter(row => row.path.endsWith('/data.yaml'));

// This corpus has only this small fixed YAML grammar. Reject extra/missing keys,
// rather than introducing a permissive parser or changing the upstream bytes.
function parseVector(bytes) {
  const source = bytes.toString('utf8');
  const match = /^input:\s*\{commitment:\s*'(0x[0-9a-fA-F]*)',\s*z:\s*'(0x[0-9a-fA-F]*)',\s*y:\s*'(0x[0-9a-fA-F]*)',\s*proof:\s*'(0x[0-9a-fA-F]*)'\}\s*output:\s*(true|false|null)\s*$/.exec(source);
  assert.ok(match, 'exact four-field upstream input grammar');
  return { args: match.slice(1, 5), expected: JSON.parse(match[5]) };
}

test('all retained upstream bytes, setup, licenses and corpus counts are bound', async () => {
  assert.equal(sha(provenanceBytes), '0c595617f546325099f8bc38956d4f489ee52c5feb827f458f3ac608a8449da6');
  assert.equal(provenance.files.length, 128);
  assert.equal(vectorRecords.length, 122);
  assert.deepEqual(provenance.counts, { verifyKzgProof: 122, outputs: { true: 54, false: 48, null: 20 }, gethPointEvaluation: 1 });
  const names = [];
  async function walk(relative = '') {
    for (const item of await readdir(new URL(relative, directory), { withFileTypes: true })) {
      assert.ok(item.isFile() || item.isDirectory(), 'no fixture symlinks');
      const path = relative + item.name;
      if (item.isDirectory()) await walk(path + '/'); else names.push(path);
    }
  }
  await walk();
  assert.deepEqual(names.sort(), ['provenance.json', ...provenance.files.map(row => row.path)].sort());
  for (const row of provenance.files) {
    const bytes = await readFile(new URL(row.path, directory));
    assert.equal(bytes.length, row.bytes, row.path);
    assert.equal(sha(bytes), row.sha256, row.path);
  }
  const setup = JSON.parse(await readFile(new URL('upstream/trusted_setup.json', directory)));
  assert.deepEqual([setup.g1_monomial.length, setup.g1_lagrange.length, setup.g2_monomial.length], [4096, 4096, 65]);
  assert.equal(setup.g2_monomial[1], KZG_POINT_EVALUATION_SETUP.g2Monomial);
  assert.equal(setup.g2_monomial[0], '0x' + Buffer.from(bls.G2.Point.BASE.toBytes(true)).toString('hex'));
  assert.equal(provenance.runtimeSetup.sha256, KZG_POINT_EVALUATION_SETUP.sourceSha256);
  assert.ok(Object.isFrozen(KZG_POINT_EVALUATION_SETUP));
});

test('all 122 upstream verify_kzg_proof cases retain true/false/malformed distinctions', async t => {
  const counts = { true: 0, false: 0, null: 0 };
  for (const row of vectorRecords) {
    await t.test(row.path.split('/').at(-2), async () => {
      const bytes = await readFile(new URL(row.path, directory));
      assert.equal(sha(bytes), row.sha256);
      const { args, expected } = parseVector(bytes);
      counts[String(expected)]++;
      if (expected === null) assert.throws(() => verifyKzgProof(...args), KzgInputError);
      else assert.equal(verifyKzgProof(...args), expected);
    });
  }
  assert.deepEqual(counts, { true: 54, false: 48, null: 20 });
});

test('pinned Geth point-evaluation vector verifies directly without an EVM execution', async () => {
  const bytes = await readFile(new URL('upstream/pointEvaluation.json', directory));
  assert.equal(sha(bytes), 'e831a6e4b7c848ae012e75adfe7724caeb95e2ecb79af7e853e26ccdbe5cdc9d');
  const vectors = JSON.parse(bytes);
  assert.equal(vectors.length, 1);
  const { Input, Expected, Gas, Name } = vectors[0];
  assert.equal(Name, 'pointEvaluation1');
  assert.equal(Input.length, 192 * 2);
  assert.equal(Gas, 50000);
  const commitment = Input.slice(192, 288), proof = Input.slice(288, 384);
  assert.equal(Input.slice(0, 64), '01' + sha(Buffer.from(commitment, 'hex')).slice(2));
  assert.equal(verifyKzgProof('0x' + commitment, '0x' + Input.slice(64, 128), '0x' + Input.slice(128, 192), '0x' + proof), true);
  assert.equal(Expected, word(4096n).slice(2) + word(bls.fields.Fr.ORDER).slice(2));
});

test('zero-safe identity terms and zero scalars preserve the pairing equation', () => {
  for (const z of [zero, one, word(bls.fields.Fr.ORDER - 1n)]) {
    assert.equal(verifyKzgProof(infinity, z, zero, infinity), true);
    assert.equal(verifyKzgProof(infinity, z, one, infinity), false);
    assert.equal(verifyKzgProof(generator, z, one, infinity), true);
    assert.equal(verifyKzgProof(generator, z, zero, infinity), false);
  }
});

test('exact scalar widths and the unreduced scalar modulus are enforced', () => {
  for (const value of [null, undefined, 0n, 0, new Uint8Array(32), '', zero.slice(2), '0X' + zero.slice(2), '0x0', zero + '00', '0x' + 'gg'.repeat(32), word(bls.fields.Fr.ORDER), word((1n << 256n) - 1n)]) {
    assert.throws(() => verifyKzgProof(infinity, value, zero, infinity), KzgInputError);
    assert.throws(() => verifyKzgProof(infinity, zero, value, infinity), KzgInputError);
  }
  assert.equal(verifyKzgProof(generator.toUpperCase().replace('0X', '0x'), zero, one, infinity), true);
});

test('points require canonical compressed subgroup encodings, including canonical infinity', () => {
  const xAtModulus = bls.fields.Fp.ORDER | (1n << 383n);
  const bad = [null, new Uint8Array(48), infinity.slice(2), infinity + '00', '0x' + '00'.repeat(48),
    '0xe0' + '00'.repeat(47), '0xc0' + '00'.repeat(46) + '01',
    '0x' + xAtModulus.toString(16).padStart(96, '0'),
    // x=0 gives y=2 on the curve but outside the prime-order G1 subgroup.
    '0x80' + '00'.repeat(47),
    '0x' + Buffer.from(bls.G1.Point.BASE.toBytes(false)).toString('hex')];
  for (const value of bad) {
    assert.throws(() => verifyKzgProof(value, zero, zero, infinity), KzgInputError);
    assert.throws(() => verifyKzgProof(infinity, zero, zero, value), KzgInputError);
  }
});

test('malformed input errors are recognizable while unexpected host failures remain distinct', t => {
  const malformed = new KzgInputError();
  assert.equal(malformed.code, 'C_KZG_BADARGS');
  assert.match(malformed.message, /C_KZG_BADARGS/);
  for (const failure of [new Error('synthetic host fault'), null, undefined]) {
    // No public verifier or setup injection exists. A host Buffer failure must
    // propagate unchanged so the executor can invalidate the entire attempt.
    const replacement = t.mock.method(Buffer, 'from', () => { throw failure; });
    let threw = false, caught;
    try { verifyKzgProof(infinity, zero, zero, infinity); }
    catch (error) { threw = true; caught = error; }
    finally { replacement.mock.restore(); }
    assert.equal(threw, true);
    assert.equal(caught, failure);
  }
});
