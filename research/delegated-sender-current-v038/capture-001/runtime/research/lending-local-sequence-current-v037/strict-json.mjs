// Pure bounded JSON parsing. The scanner rejects duplicate decoded object
// names before JSON.parse can discard them. It never rewrites the input text;
// callers retain their original UTF-8/wire bytes independently.
import { types } from 'node:util';

export const STRICT_JSON_LIMITS = Object.freeze({ maxBytes: 2 * 1024 * 1024, maxDepth: 128, maxWork: 8 * 1024 * 1024 });
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const invalid = () => fail('STRICT_JSON_INVALID', 'Input is not valid bounded JSON.');
const limited = () => fail('STRICT_JSON_LIMIT', 'JSON parsing exceeded its declared bound.');
const digit = n => n >= 48 && n <= 57;
const hex = n => digit(n) || n >= 65 && n <= 70 || n >= 97 && n <= 102;
function bounds(options) {
  if (!options || typeof options !== 'object' || types.isProxy(options) || Array.isArray(options)
    || ![Object.prototype, null].includes(Object.getPrototypeOf(options))) invalid();
  const result = { ...STRICT_JSON_LIMITS };
  for (const key of Reflect.ownKeys(options)) {
    const descriptor = Object.getOwnPropertyDescriptor(options, key);
    if (typeof key !== 'string' || !Object.hasOwn(result, key) || !descriptor.enumerable || !Object.hasOwn(descriptor, 'value')) invalid();
    const value = descriptor.value;
    if (!Number.isSafeInteger(value) || value < 1 || value > result[key]) limited();
    result[key] = value;
  }
  return result;
}

/** JSON.parse-equivalent values for admitted text, including ordinary object
 * prototypes, number rounding and negative zero. Bounds may only be reduced.
 * Work counts UTF-16 units in the UTF-8 sizing pass, consumed scanner input,
 * decoded key tokens and final native parse, plus one unit per value. Native
 * parsing is admitted only after the input and container depth are bounded. */
export function parseStrictJson(text, options = {}) {
  const { maxBytes, maxDepth, maxWork } = bounds(options);
  if (typeof text !== 'string') invalid();
  // UTF-8 byte length is at least the UTF-16 code-unit length. This first guard
  // avoids traversing an arbitrarily large input even for its byte count.
  if (text.length > maxBytes) limited();
  let cursor = 0, work = 0;
  function charge(count) { work += count; if (work > maxWork) limited(); }
  charge(text.length);
  if (Buffer.byteLength(text, 'utf8') > maxBytes) limited();
  function consume(count = 1) { charge(count); cursor += count; }
  function whitespace() {
    while (cursor < text.length) {
      const n = text.charCodeAt(cursor);
      if (n !== 32 && n !== 9 && n !== 10 && n !== 13) break;
      consume();
    }
  }
  function stringToken() {
    if (text.charCodeAt(cursor) !== 34) invalid();
    const start = cursor; consume();
    while (cursor < text.length) {
      const n = text.charCodeAt(cursor); consume();
      if (n === 34) return [start, cursor];
      if (n < 32) invalid();
      if (n !== 92) continue;
      if (cursor >= text.length) invalid();
      const escape = text.charCodeAt(cursor); consume();
      if ([34, 47, 92, 98, 102, 110, 114, 116].includes(escape)) continue;
      if (escape !== 117 || cursor + 4 > text.length) invalid();
      for (let i = 0; i < 4; i++) { if (!hex(text.charCodeAt(cursor))) invalid(); consume(); }
    }
    invalid();
  }
  function numberToken() {
    if (text[cursor] === '-') consume();
    if (text[cursor] === '0') consume();
    else {
      const first = text.charCodeAt(cursor);
      if (first < 49 || first > 57 || !Number.isFinite(first)) invalid();
      do { consume(); } while (digit(text.charCodeAt(cursor)));
    }
    if (text[cursor] === '.') {
      consume(); if (!digit(text.charCodeAt(cursor))) invalid();
      do { consume(); } while (digit(text.charCodeAt(cursor)));
    }
    if (text[cursor] === 'e' || text[cursor] === 'E') {
      consume(); if (text[cursor] === '+' || text[cursor] === '-') consume();
      if (!digit(text.charCodeAt(cursor))) invalid();
      do { consume(); } while (digit(text.charCodeAt(cursor)));
    }
  }
  function value(depth) {
    charge(1); whitespace();
    const token = text[cursor];
    if (token === '"') { stringToken(); return; }
    if (token === '{' || token === '[') {
      if (depth >= maxDepth) limited();
      const object = token === '{', close = object ? '}' : ']';
      const names = object ? new Set() : null;
      consume(); whitespace();
      if (text[cursor] === close) { consume(); return; }
      while (true) {
        if (object) {
          const [start, end] = stringToken(); charge(end - start);
          const name = JSON.parse(text.slice(start, end));
          if (names.has(name)) fail('STRICT_JSON_DUPLICATE_KEY', 'JSON object contains a duplicate decoded member name.');
          names.add(name); whitespace();
          if (text[cursor] !== ':') invalid();
          consume();
        }
        value(depth + 1); whitespace();
        if (text[cursor] === close) { consume(); return; }
        if (text[cursor] !== ',') invalid();
        consume(); whitespace();
      }
    }
    for (const literal of ['true', 'false', 'null']) {
      if (text.startsWith(literal, cursor)) { consume(literal.length); return; }
    }
    if (token === '-' || digit(text.charCodeAt(cursor))) { numberToken(); return; }
    invalid();
  }
  value(0); whitespace();
  if (cursor !== text.length) invalid();
  charge(text.length);
  return JSON.parse(text);
}
