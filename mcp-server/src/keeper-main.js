#!/usr/bin/env node
/**
 * keeper-main.js — 远程托管签名器 Keeper 的独立进程入口。
 *
 * **必须运行在人类侧主机**（私钥物理所在处）。绝不 import 进云端 server 进程。
 *
 * 启动（全部 env fail-closed，缺任一即拒绝启动）：
 *   REMOTE_SIGNER_KEEPER_PORT=7788 \
 *   NG_CUSTODY_TOKEN_SECRET=<≥32字符，与 L1 服务器共享> \
 *   REMOTE_SIGNER_SHARED_SECRET=<≥32字符，与 AGENT 共享> \
 *   REMOTE_SIGNER_KEYRING_FILE=./keyring.json \
 *   REMOTE_SIGNER_APPROVAL_MODE=deny \
 *   node src/keeper-main.js
 *
 * keyring.json 形态：
 *   { "<agentId>": { "privateKeyHex": "0x…64hex", "session": { …createSessionKey 产物… } } }
 *   — session 为 Keeper（人类/owner 侧）签发时登记的权威副本；请求 session 与之
 *     不符即拒签（防 AGENT 自造宽限额 session）。
 */

import { startRealKeeperFromEnv } from './remote-signer-keeper.js';

const server = startRealKeeperFromEnv();
if (!server) {
  console.error('[keeper] REMOTE_SIGNER_KEEPER_PORT not set — gate off, nothing to run.');
  process.exit(1);
}
console.log('[keeper] listening (see remote_signer_keeper_* structured logs).');
