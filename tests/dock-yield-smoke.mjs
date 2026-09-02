/**
 * dock 让位量冒烟测试（computeDockYield 的边界情况）：
 *  - 无 details 列：让位 = dock 全宽
 *  - details 列比 dock 宽：重叠为 0，不让位
 *  - dock 比 details 列宽：只让实际压进中列的部分
 *  - 中列太窄：被最小保留宽度兜底 clamp
 * 运行：node tests/dock-yield-smoke.mjs
 */
import { computeDockYield } from "../src/dock-yield.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};
const eq = (actual, expected, message) => {
  if (actual !== expected) throw new Error(`FAIL: ${message}（期望 ${expected}，实际 ${actual}）`);
};

/* 无 details 列：中列右缘 ≈ 视口宽，让位 = dock 全宽 */
eq(computeDockYield(1920, 1500, 1920, 300), 300, "无 details 列时让出 dock 全宽");
eq(computeDockYield(1920, 1500, 1920, 560), 560, "宽 dock 同样全让");

/* details 列开着且比 dock 宽：dock 只盖 details，不让位 */
eq(computeDockYield(1500, 1100, 1920, 300), 0, "details 列盖得住 dock 时不让位");

/* dock 比 details 列宽：只让压进中列的部分（dock 左缘 1920-560=1360，压进中列 260px） */
eq(computeDockYield(1620, 1220, 1920, 560), 260, "部分重叠时只让重叠量");

/* 中列太窄：最小保留宽度兜底 */
eq(computeDockYield(1920, 500, 1920, 300), 180, "中列 500px 只让 180px（保底 320）");
eq(computeDockYield(1920, 300, 1920, 300), 0, "中列已到保底线，不再让");
eq(computeDockYield(1920, 200, 1920, 300), 0, "中列低于保底线，clamp 到 0");

/* dock 拖到最宽、窗口中等大小的组合：重叠 560 但保底只允许 380 */
eq(computeDockYield(1000, 700, 1000, 560), 380, "窄窗口下按保底 clamp");

console.log("ALL DOCK-YIELD SMOKE TESTS PASSED");
