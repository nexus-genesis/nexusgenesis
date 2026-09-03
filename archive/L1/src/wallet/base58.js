/**
 * Base58 encoding/解码工具
 * for NexusGenesis addressGenerate
 */

const ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const ALPHABET_MAP = {};

for (let i = 0; i < ALPHABET.length; i++) {
  ALPHABET_MAP[ALPHABET.charAt(i)] = i;
}

/**
 * Base58 encoding
 * @param {Buffer} buffer - 待编码的缓冲区
 * @returns {string} - Base58 字符串
 */
export function base58Encode(buffer) {
  if (buffer.length === 0) return '';
  
  // Calculate前导零的数量
  let zeros = 0;
  while (zeros < buffer.length && buffer[zeros] === 0) {
    zeros++;
  }
  
  // 将 Buffer 转换为大整数
  let num = BigInt('0x' + buffer.toString('hex'));
  let encoded = '';
  
  // 转换为 Base58
  while (num > 0n) {
    const remainder = num % 58n;
    num = num / 58n;
    encoded = ALPHABET[Number(remainder)] + encoded;
  }
  
  // 添加前导 '1' (代表零字节)
  return '1'.repeat(zeros) + encoded;
}

/**
 * Base58 解码
 * @param {string} string - Base58 字符串
 * @returns {Buffer} - 解码后的缓冲区
 */
export function base58Decode(string) {
  if (string.length === 0) return Buffer.alloc(0);
  
  // Calculate前导 '1' 的数量
  let zeros = 0;
  while (zeros < string.length && string.charAt(zeros) === '1') {
    zeros++;
  }
  
  // 将 Base58 转换为大整数
  let num = 0n;
  for (let i = zeros; i < string.length; i++) {
    const char = string.charAt(i);
    if (!(char in ALPHABET_MAP)) {
      throw new Error(`Invalid Base58 character: ${char}`);
    }
    num = num * 58n + BigInt(ALPHABET_MAP[char]);
  }
  
  // 转换为十六进制字符串
  let hex = num.toString(16);
  
  // ensure十六进制字符串length为偶数
  if (hex.length % 2 !== 0) {
    hex = '0' + hex;
  }
  
  // Create Buffer 并添加前导零
  const buffer = Buffer.from(hex, 'hex');
  const prefixZeros = Buffer.alloc(zeros);
  
  return Buffer.concat([prefixZeros, buffer]);
}

/**
 * Verify Base58 字符串是否有效
 * @param {string} string - pending verification的字符串
 * @returns {boolean}
 */
export function isValidBase58(string) {
  for (let i = 0; i < string.length; i++) {
    if (!(string.charAt(i) in ALPHABET_MAP)) {
      return false;
    }
  }
  return true;
}
