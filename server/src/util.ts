/** 内核小工具 */

/** 稳定字符串哈希（djb2）：用于确定性比对，非密码学用途 */
export function hashString(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return (h >>> 0).toString(16);
}

export function randomId(prefix: string): string {
  return prefix + "_" + Math.random().toString(36).slice(2, 10);
}

/** 带超时的 Promise：超时/异常一律 reject，由调用方兜底（容错优先） */
export function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("TIMEOUT")), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}
