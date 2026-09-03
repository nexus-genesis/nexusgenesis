/**
 * NexusGenesis - 内存卫生工具（节点运行时）
 * 与 packages/agent-keys/src/secure.js 保持同一语义，独立副本以避免
 * 节点软件对 SDK 包的构建依赖。
 *
 * 能力边界（SECURITY BOUNDARY）：
 *   能做到：确定性覆写显式持有的 ArrayBuffer；缩小明文密钥暴露窗口。
 *   不能做到：覆盖 V8 栈临时拷贝/JIT 中间数据、库内部副本、防 core
 *   dump 落盘（需 setrlimit/系统配置）、防 swap（需加密 swap）、防
 *   DMA/冷启动等物理内存读取（TEE 领域）。
 */

/**
 * 确定性覆写 Buffer 内容（立即生效，不依赖 GC）
 * @param {...(Buffer|Uint8Array|null|undefined)} bufs
 */
export function secureZero(...bufs) {
  for (const buf of bufs) {
    if (buf == null) continue;
    if (Buffer.isBuffer(buf) || buf instanceof Uint8Array) {
      try {
        buf.fill(0);
      } catch {
        // detached / read-only buffer — 跳过
      }
    }
  }
}

/**
 * 尽力禁用当前进程的 core dump（Windows 下为 no-op）
 * @returns {boolean} 是否成功应用
 */
export function disableCoreDumps() {
  try {
    if (typeof process.setrlimit === 'function') {
      process.setrlimit('core', { soft: 0, hard: 0 });
      return true;
    }
  } catch {
    // Windows / 受限环境
  }
  return false;
}

export default { secureZero, disableCoreDumps };
