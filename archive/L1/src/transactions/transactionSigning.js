export function canonicalize(value) {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return '[' + value.map(canonicalize).join(',') + ']';
  }

  const keys = Object.keys(value).sort();
  const pairs = keys.map(key => `"${key}":${canonicalize(value[key])}`);
  return '{' + pairs.join(',') + '}';
}

export async function signSpecialTransactionWithWallet(transaction, wallet) {
  const txData = { ...transaction };
  delete txData.signature;
  return wallet.sign(canonicalize(txData));
}
