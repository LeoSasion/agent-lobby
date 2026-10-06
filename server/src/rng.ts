/** 确定性随机：match 级 seed → 回放精确复现（规划 §5.2 决策 2） */

export type Rng = () => number;

/** mulberry32：小、快、可移植的种子随机数发生器 */
export function mulberry32(seed: number): Rng {
  let a = seed >>> 0;
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 真实对局用随机 seed（冒烟测试请显式传入固定 seed） */
export function randomSeed(): number {
  return Math.floor(Math.random() * 2 ** 31);
}
