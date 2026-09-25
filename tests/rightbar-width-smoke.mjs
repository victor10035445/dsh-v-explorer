/**
 * 右栏默认宽度种子冒烟测试（specs/sidebar-auto-open · 默认宽度，2026-09-25）：
 *  1. 冷启动（无 DOM 把手）→ panels.setRightbar(300) 恰好一次（契约最小 RIGHTBAR_MIN）
 *  2. 形状探测：panels / setRightbar 缺席 → warn 一次、不抛、不写入（design D9 降级）
 *  3. 热重载守卫：把手在场且当前列宽 = 官方默认播种（45% 视口）→ 照常写入
 *  4. 热重载守卫：把手在场且当前列宽 = 用户自选（≠ 默认播种）→ 跳过写入
 *  5. 写入抛错（宿主动作异常）→ 吞掉 + warn，不向 apply 传播
 *
 * 运行：node tests/rightbar-width-smoke.mjs
 */
import { installRightbarDefaultWidth } from "../src/rightbar-width.mjs";

const assert = (cond, message) => {
  if (!cond) throw new Error("FAIL: " + message);
};

/* 官方契约换算：默认播种 = max(300, round(viewport×0.45))；把手 inline left = 视口 − 列宽。 */
const fakeHandle = (viewport, rightbarWidth) => ({
  style: { left: `${viewport - rightbarWidth}px` },
  parentElement: { getBoundingClientRect: () => ({ width: viewport }) }
});

function withWarnings(fn) {
  const warns = [];
  const orig = console.warn;
  console.warn = (...args) => warns.push(args.join(" "));
  try {
    fn();
  } finally {
    console.warn = orig;
  }
  return warns;
}

(() => {
  /* ── 1. 冷启动：无 document（node 环境）→ 预置 300 ── */
  {
    const calls = [];
    const warns = withWarnings(() => installRightbarDefaultWidth({ layout: { panels: { setRightbar: (px) => calls.push(px) } } }));
    assert(calls.length === 1 && calls[0] === 300, "cold boot must seed the saved preference to the 300px contract minimum, got " + JSON.stringify(calls));
    assert(warns.length === 0, "cold boot must not warn");
  }

  /* ── 2a. layout 缺席 → 降级 ── */
  {
    const warns = withWarnings(() => installRightbarDefaultWidth({}));
    assert(warns.length === 1 && warns[0].includes("default width seeding skipped"), "missing layout must warn once and degrade");
  }

  /* ── 2b. setRightbar 缺席（宿主形状漂移）→ 降级 ── */
  {
    const warns = withWarnings(() => installRightbarDefaultWidth({ layout: { panels: {} } }));
    assert(warns.length === 1 && warns[0].includes("default width seeding skipped"), "shape drift must warn once and degrade");
  }

  /* ── 3. 把手在场 + 宽度 = 官方默认播种（未被动过）→ 照常写入 ── */
  globalThis.document = {
    querySelector: (sel) => (sel === '[data-side="rightbar"]' ? fakeHandle(2000, 900) : null) /* 900 = round(2000×0.45) */
  };
  {
    const calls = [];
    installRightbarDefaultWidth({ layout: { panels: { setRightbar: (px) => calls.push(px) } } });
    assert(calls.length === 1 && calls[0] === 300, "untouched default-seeded width must still be re-seeded to the minimum");
  }

  /* ── 4. 把手在场 + 宽度 = 用户自选（600 ≠ 默认 900）→ 跳过 ── */
  globalThis.document.querySelector = (sel) => (sel === '[data-side="rightbar"]' ? fakeHandle(2000, 600) : null);
  {
    const calls = [];
    const warns = withWarnings(() => installRightbarDefaultWidth({ layout: { panels: { setRightbar: (px) => calls.push(px) } } }));
    assert(calls.length === 0, "user-chosen width must not be clobbered");
    assert(warns.length === 0, "intentional skip must stay silent");
  }

  /* ── 5. 写入抛错 → 吞掉 + warn，不向 apply 传播 ── */
  globalThis.document.querySelector = () => null;
  {
    const warns = withWarnings(() =>
      installRightbarDefaultWidth({
        layout: {
          panels: {
            setRightbar: () => {
              throw new Error("store engine exploded");
            }
          }
        }
      })
    );
    assert(warns.length === 1 && warns[0].includes("rightbar default width seeding skipped"), "throwing write must be swallowed with one warning");
  }

  delete globalThis.document;
  console.log("\nALL RIGHTBAR-WIDTH SMOKE TESTS PASSED");
  process.exit(0);
})().catch((e) => {
  console.error("SMOKE FAILED:", e.message);
  process.exit(1);
});
