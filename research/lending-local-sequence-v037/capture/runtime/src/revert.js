// Solidity ABI errors are contract-provided data, not independently verified diagnoses.
// https://docs.soliditylang.org/en/latest/abi-spec.html#errors
const PANICS = new Map([
  [0n, 'Compiler-inserted panic.'], [1n, 'An assertion failed.'],
  [0x11n, 'Arithmetic overflow or underflow.'], [0x12n, 'Division or modulo by zero.'],
  [0x21n, 'Invalid enum conversion.'], [0x22n, 'Invalid storage byte-array encoding.'],
  [0x31n, 'Attempted to pop an empty array.'], [0x32n, 'Array index out of bounds.'],
  [0x41n, 'Excessive memory allocation.'], [0x51n, 'Called an uninitialized internal function.'],
]);
const cleanText = value => value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g, '');

export function decodeRevert(data) {
  if (typeof data !== 'string' || data.length < 10 || !/^0x(?:[0-9a-f]{2})+$/i.test(data)) return null;
  const selector = data.slice(0,10).toLowerCase();
  const base = {selector,source:'contract_return_data'};
  const malformed = signature => ({...base,kind:'malformed',message:`Malformed ${signature} revert data.`});
  if (selector === '0x08c379a0') {
    if (data.length < 138) return malformed('Error(string)');
    const args = data.slice(10);
    const offset = BigInt('0x'+args.slice(0,64));
    const length = BigInt('0x'+args.slice(64,128));
    if (offset !== 32n || length > 4096n) return malformed('Error(string)');
    const paddedLength = ((length + 31n) / 32n) * 32n;
    if (BigInt(args.length) !== 128n + paddedLength * 2n) return malformed('Error(string)');
    const end = 128 + Number(length)*2;
    if (!/^0*$/.test(args.slice(end))) return malformed('Error(string)');
    let reason;
    try { reason = new TextDecoder('utf-8',{fatal:true}).decode(Buffer.from(args.slice(128,end),'hex')); }
    catch { return malformed('Error(string)'); }
    return {...base,kind:'error_string',message:cleanText(reason)};
  }
  if (selector === '0x4e487b71') {
    if (data.length !== 74) return malformed('Panic(uint256)');
    const code = BigInt('0x'+data.slice(10));
    return {...base,kind:'panic',code:'0x'+code.toString(16),message:PANICS.get(code) || 'Unrecognized Solidity panic code.'};
  }
  return {...base,kind:'custom_error',message:'Custom error; no verified ABI is configured for this selector.'};
}
