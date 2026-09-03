import crypto from 'crypto';
import bs58 from 'bs58';

const CHECKSUM_LENGTH = 4;

export const ADDRESS_VERSION = 0x00;
export const ADDRESS_PREFIX = 'ng1';

export function base58Encode(buffer) {
  return bs58.encode(buffer);
}

export function base58Decode(encoded) {
  return Buffer.from(bs58.decode(encoded));
}

export function generateAddress(publicKey) {
  const digest = crypto.createHash('sha3-256').update(publicKey).digest();
  const versionedPayload = Buffer.concat([Buffer.from([ADDRESS_VERSION]), digest]);
  const checksum = crypto.createHash('sha3-256').update(versionedPayload).digest().subarray(0, CHECKSUM_LENGTH);
  return ADDRESS_PREFIX + base58Encode(Buffer.concat([versionedPayload, checksum]));
}

export function validateAddressFormat(address) {
  if (!address || typeof address !== 'string') {
    return false;
  }

  if (!address.startsWith(ADDRESS_PREFIX)) {
    return false;
  }

  const encoded = address.slice(ADDRESS_PREFIX.length);
  if (encoded.length === 0) {
    return false;
  }

  try {
    const decoded = base58Decode(encoded);
    const expectedLength = 1 + 32 + CHECKSUM_LENGTH;
    if (decoded.length !== expectedLength) {
      return false;
    }

    const versionedPayload = decoded.subarray(0, decoded.length - CHECKSUM_LENGTH);
    const storedChecksum = decoded.subarray(decoded.length - CHECKSUM_LENGTH);
    const computedChecksum = crypto.createHash('sha3-256')
      .update(versionedPayload)
      .digest()
      .subarray(0, CHECKSUM_LENGTH);

    return Buffer.compare(storedChecksum, computedChecksum) === 0;
  } catch {
    return false;
  }
}

export function generateWalletKeyPair() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const jwk = publicKey.export({ format: 'jwk' });
  const privJwk = privateKey.export({ format: 'jwk' });
  const pubHex = Buffer.from(jwk.x, 'base64url').toString('hex');
  const privHex = Buffer.from(privJwk.d, 'base64url').toString('hex');
  return {
    publicKeyHex: pubHex,
    privateKeyHex: privHex,
    address: generateAddress(Buffer.from(pubHex, 'hex'))
  };
}

export function signMessage(privateKeyHex, publicKeyHex, message) {
  const privJwk = {
    kty: 'OKP',
    crv: 'Ed25519',
    d: Buffer.from(privateKeyHex, 'hex').toString('base64url'),
    x: Buffer.from(publicKeyHex, 'hex').toString('base64url')
  };
  const privKey = crypto.createPrivateKey({ key: privJwk, format: 'jwk' });
  const msgBuf = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
  return crypto.sign(null, msgBuf, privKey).toString('hex');
}

export function verifySignature(publicKeyHex, message, signatureHex) {
  try {
    const pubJwk = {
      kty: 'OKP',
      crv: 'Ed25519',
      x: Buffer.from(publicKeyHex, 'hex').toString('base64url')
    };
    const pubKey = crypto.createPublicKey({ key: pubJwk, format: 'jwk' });
    const msgBuf = Buffer.from(typeof message === 'string' ? message : JSON.stringify(message));
    return crypto.verify(null, msgBuf, pubKey, Buffer.from(signatureHex, 'hex'));
  } catch {
    return false;
  }
}