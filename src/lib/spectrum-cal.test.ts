import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { energyOf, fitLinearCalibration } from "./spectrum.ts";

describe("fitLinearCalibration", () => {
  it("recovers exact C0/C1 from two points", () => {
    const c0 = 19.128;
    const c1 = 1.1295;
    const fit = fitLinearCalibration([
      { ch: 100, energy: energyOf(100, c0, c1) },
      { ch: 2000, energy: energyOf(2000, c0, c1) },
    ]);
    assert.ok(Math.abs(fit.c0 - c0) < 1e-9);
    assert.ok(Math.abs(fit.c1 - c1) < 1e-12);
    assert.equal(fit.n, 2);
    assert.ok(fit.rms < 1e-9);
    assert.ok(fit.r2 > 0.999999);
  });

  it("fits three slightly noisy points", () => {
    const c0 = 19.128;
    const c1 = 1.1295;
    const fit = fitLinearCalibration([
      { ch: 100, energy: energyOf(100, c0, c1) + 0.2 },
      { ch: 568.2, energy: energyOf(568.2, c0, c1) - 0.15 },
      { ch: 1140, energy: energyOf(1140, c0, c1) + 0.1 },
    ]);
    assert.ok(Math.abs(fit.c0 - c0) < 0.5);
    assert.ok(Math.abs(fit.c1 - c1) < 0.002);
    assert.ok(fit.rms < 0.3);
    assert.ok(fit.r2 > 0.999999);
  });

  it("rejects fewer than two points", () => {
    assert.throws(() => fitLinearCalibration([{ ch: 10, energy: 50 }]), /至少需要 2/);
  });

  it("rejects identical channels", () => {
    assert.throws(
      () =>
        fitLinearCalibration([
          { ch: 50, energy: 10 },
          { ch: 50, energy: 20 },
        ]),
      /道址不能全部相同/,
    );
  });
});
