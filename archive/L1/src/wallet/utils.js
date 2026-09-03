/**
 * Base58 encoding/decoding utilities
 */

// Base58 alphabet (Bitcoin style)
const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

export function encodeBase58(buffer) {
  if (buffer.length === 0) return '';
  
  let num = BigInt('0x' + buffer.toString('hex'));
  let encoded = '';
  
  while (num > 0n) {
    const remainder = Number(num % 58n);
    encoded = ALPHABET[remainder] + encoded;
    num = num / 58n;
  }
  
  // Handle leading zeros
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) {
    encoded = '1' + encoded;
  }
  
  return encoded;
}

export function decodeBase58(string) {
  if (string.length === 0) return Buffer.alloc(0);
  
  let num = 0n;
  for (let i = 0; i < string.length; i++) {
    const char = string[i];
    const index = ALPHABET.indexOf(char);
    if (index === -1) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }
    num = num * 58n + BigInt(index);
  }
  
  // Convert back to buffer
  const hex = num.toString(16).padStart(string.length * 2, '0');
  return Buffer.from(hex, 'hex');
}

export const base58 = { encode: encodeBase58, decode: decodeBase58 };
