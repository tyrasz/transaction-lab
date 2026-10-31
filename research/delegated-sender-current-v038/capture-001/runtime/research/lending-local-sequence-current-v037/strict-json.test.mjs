// Pure parser controls only: no transport, target VM, source freeze or capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseStrictJson, STRICT_JSON_LIMITS } from './strict-json.mjs';

const rejects = (text, code = 'STRICT_JSON_INVALID', options) => assert.throws(() => parseStrictJson(text, options), error => error.code === code);

test('ordinary noncanonical JSON text retains native parse semantics without changing its bytes', () => {
  const values = ['null', 'true', 'false', '0', '-0', '1.25e+3', '-1E-2', '9007199254740993', '1e999',
    '"text"', '"\\u0061\\n\\t\\b\\f\\r\\/\\\\\\\""', '"\\ud800"', '[]', '{}',
    ' \r\n { "z" : [1, false, null, {"x": "é😀"}], "a":2 }\t ',
    '{"__proto__":{"x":1},"constructor":2,"toString":3}',
    '{"a":1,"nested":{"a":2},"items":[{"a":3},{"a":4}]}'];
  for (const text of values) {
    const before = Buffer.from(text, 'utf8');
    assert.deepEqual(parseStrictJson(text), JSON.parse(text));
    assert.deepEqual(Buffer.from(text, 'utf8'), before);
  }
  assert(Object.is(parseStrictJson('-0'), -0));
  assert.equal(Object.getPrototypeOf(parseStrictJson('{"__proto__":1}')), Object.prototype);
});

test('duplicate decoded member names are rejected at every object depth including array members', () => {
  for (const text of ['{"result":"0xaa36a7","result":"0x1"}', '{"id":1,"id":2}',
    '{"outer":{"hash":"bad","hash":"good"}}', '[{"x":1,"x":2}]',
    '{"a":[1,{"b":[{"stateRoot":1,"stateRoot":2}]}]}',
    '{"":1,"":2}', '{"__proto__":1,"__proto__":2}']) rejects(text, 'STRICT_JSON_DUPLICATE_KEY');
});

test('escaped equivalents collide while distinct decoded names remain distinct', () => {
  for (const text of [String.raw`{"result":1,"\u0072esult":2}`,
    String.raw`{"\u0061":1,"a":2}`, String.raw`{"a/b":1,"a\/b":2}`,
    String.raw`{"\u0000":1,"\u0000":2}`, String.raw`{"\n":1,"\u000a":2}`,
    String.raw`{"😀":1,"\ud83d\ude00":2}`, String.raw`{"é":1,"\u00e9":2}`,
    String.raw`{"\uD800":1,"\ud800":2}`]) rejects(text, 'STRICT_JSON_DUPLICATE_KEY');
  const text = String.raw`{"é":1,"e\u0301":2,"A":3,"a":4,"\u0000":5,"null":6}`;
  assert.deepEqual(parseStrictJson(text), JSON.parse(text));
});

test('malformed grammar, trailing data and invalid escapes cannot reach the native value parser', () => {
  for (const text of ['', ' ', 'undefined', 'NaN', 'Infinity', '+1', '01', '-01', '-', '1.', '.1', '1e', '1e+',
    'true false', 'nullx', '[1,]', '{"a":1,}', '{a:1}', '{"a" 1}', '[,1]', '{', '[', '"',
    String.raw`"\x61"`, String.raw`"\u000x"`, String.raw`"\u001"`, '"line\nbreak"',
    '"tab\tbreak"', '/*comment*/1', '\ufeff{}', '[1}', '{"a":1]']) rejects(text);
});

test('byte bound counts UTF-8 bytes and can only be lowered from the fixed ceiling', () => {
  assert.equal(parseStrictJson('"é"', { maxBytes: 4 }), 'é');
  rejects('"é"', 'STRICT_JSON_LIMIT', { maxBytes: 3 });
  rejects(' '.repeat(STRICT_JSON_LIMITS.maxBytes + 1), 'STRICT_JSON_LIMIT');
  rejects('0', 'STRICT_JSON_LIMIT', { maxBytes: STRICT_JSON_LIMITS.maxBytes + 1 });
  rejects('0', 'STRICT_JSON_LIMIT', { maxBytes: 0 });
  rejects('0', 'STRICT_JSON_LIMIT', { maxBytes: Infinity });
});

test('container depth is explicit for both arrays and objects with an exact boundary', () => {
  const nested = depth => '['.repeat(depth) + '0' + ']'.repeat(depth);
  assert.deepEqual(parseStrictJson(nested(128)), JSON.parse(nested(128)));
  rejects(nested(129), 'STRICT_JSON_LIMIT');
  assert.deepEqual(parseStrictJson('{"a":[0]}', { maxDepth: 2 }), { a: [0] });
  rejects('{"a":[0]}', 'STRICT_JSON_LIMIT', { maxDepth: 1 });
  rejects('0', 'STRICT_JSON_LIMIT', { maxDepth: 129 });
});

test('declared work budget includes sizing, scanner, key decoding and final native parsing', () => {
  assert.equal(parseStrictJson('0', { maxWork: 4 }), 0);
  rejects('0', 'STRICT_JSON_LIMIT', { maxWork: 3 });
  // Seven code units: three input passes, one decoded three-unit key and two values.
  assert.deepEqual(parseStrictJson('{"a":0}', { maxWork: 26 }), { a: 0 });
  rejects('{"a":0}', 'STRICT_JSON_LIMIT', { maxWork: 25 });
  rejects('0', 'STRICT_JSON_LIMIT', { maxWork: STRICT_JSON_LIMITS.maxWork + 1 });
});

test('input and bound records reject coercions, accessors, proxies and unsupported fields', () => {
  for (const input of [null, {}, [], 0, Buffer.from('{}')]) rejects(input);
  for (const options of [null, [], { unexpected: 1 }, { maxWork: 1.5 }, { maxDepth: -1 }]) {
    assert.throws(() => parseStrictJson('0', options));
  }
  let touched = false;
  const options = Object.defineProperty({}, 'maxBytes', { enumerable: true, get() { touched = true; return 10; } });
  rejects('0', 'STRICT_JSON_INVALID', options); assert.equal(touched, false);
  const proxy = new Proxy({}, { ownKeys() { touched = true; return []; } });
  rejects('0', 'STRICT_JSON_INVALID', proxy); assert.equal(touched, false);
});
