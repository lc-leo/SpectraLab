import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { applyGainFactor, energyOf, fitLinearCalibration, integral, type Spectrum } from "./spectrum.ts";

function specFrom(channels: number[], counts: number[]): Spectrum {
  const n = channels.length;
  const energy = Float64Array.from(channels, (ch) => energyOf(ch, 0, 1));
  return {
    name: "t",
    c0: 0,
    c1: 1,
    c2: 0,
    unit: "keV",
    realTime: 1,
    liveTime: 1,
    realTimeRaw: "0:00:01.000",
    liveTimeRaw: "0:00:01.000",
    n,
    channel: Int32Array.from(channels),
    counts: Float64Array.from(counts),
    energy,
  };
}

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

describe("applyGainFactor", () => {
  it("is identity at f = 1", () => {
    const s = specFrom([0, 1, 2], [4, 5, 6]);
    assert.equal(applyGainFactor(s, 1), s);
  });

  it("conserves counts when stretching", () => {
    const s = specFrom([0, 1, 2, 3, 4], [1, 2, 3, 2, 1]);
    const out = applyGainFactor(s, 2);
    assert.ok(Math.abs(integral(out.counts) - integral(s.counts)) < 1e-9);
    assert.ok(out.channel[0]! >= 0);
    assert.ok(out.n > 0);
  });

  it("moves a single-bin peak to ch · f", () => {
    const s = specFrom([0, 1, 2, 10, 11], [0, 0, 0, 100, 0]);
    const out = applyGainFactor(s, 1.5);
    let peak = 0;
    let yPeak = -Infinity;
    for (let i = 0; i < out.n; i++) {
      if ((out.counts[i] ?? 0) > yPeak) {
        yPeak = out.counts[i]!;
        peak = out.channel[i]!;
      }
    }
    assert.equal(peak, 15);
  });

  it("rejects non-positive f", () => {
    const s = specFrom([0, 1], [1, 1]);
    assert.throws(() => applyGainFactor(s, 0), /大于 0/);
  });
});
