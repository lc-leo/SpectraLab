export type Spectrum = {
  name: string;
  c0: number;
  c1: number;
  c2: number;
  unit: string;
  realTime: number;
  liveTime: number;
  realTimeRaw: string;
  liveTimeRaw: string;
  n: number;
  channel: Int32Array;
  counts: Float64Array;
  energy: Float64Array;
};

export type NetResult = {
  net: Float64Array;
  scaledBg: Float64Array;
  bgRate: Float64Array;
  n: number;
};

function matchNumber(src: string, key: string): number | null {
  const re = new RegExp(`${key}\\s*=\\s*([+-]?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?)`, "i");
  const m = src.match(re);
  if (!m) return null;
  const v = Number(m[1]);
  return Number.isFinite(v) ? v : null;
}

export function parseTimeToSeconds(raw: string): number {
  const t = raw.trim();
  if (!t) throw new Error("空的时间字段");
  if (!t.includes(":")) {
    const v = Number(t);
    if (!Number.isFinite(v) || v < 0) throw new Error(`无法解析时间: ${raw}`);
    return v;
  }
  const parts = t.split(":").map((p) => Number(p));
  if (parts.some((p) => !Number.isFinite(p) || p < 0)) {
    throw new Error(`无法解析时间: ${raw}`);
  }
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 4) {
    return parts[0] * 86400 + parts[1] * 3600 + parts[2] * 60 + parts[3];
  }
  throw new Error(`无法解析时间: ${raw}`);
}

export function formatSeconds(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  const sStr = s.toFixed(3).padStart(6, "0");
  return `${h}:${String(m).padStart(2, "0")}:${sStr}`;
}

export function energyOf(ch: number, c0: number, c1: number, c2 = 0): number {
  return c0 + c1 * ch + c2 * ch * ch;
}

export function applyCalibration(spec: Spectrum, c0: number, c1: number, c2 = spec.c2): Spectrum {
  const energy = new Float64Array(spec.n);
  for (let i = 0; i < spec.n; i++) {
    energy[i] = energyOf(spec.channel[i]!, c0, c1, c2);
  }
  return { ...spec, c0, c1, c2, energy };
}

/** Rebin histogram so each channel maps to ch′ = ch · f. Conserves total counts. */
export function applyGainFactor(spec: Spectrum, f: number): Spectrum {
  if (!Number.isFinite(f) || f <= 0) throw new Error("增益修正因子 f 必须大于 0");
  if (Math.abs(f - 1) < 1e-15) return spec;
  if (f < 0.25 || f > 4) throw new Error("增益因子偏离 1 过大（允许 0.25–4）");

  const acc = new Map<number, number>();
  const add = (bin: number, w: number) => {
    if (!(w > 0) || !Number.isFinite(w)) return;
    acc.set(bin, (acc.get(bin) ?? 0) + w);
  };

  for (let i = 0; i < spec.n; i++) {
    const ch = spec.channel[i]!;
    const c = spec.counts[i] ?? 0;
    if (!(c > 0)) continue;
    const a = ch * f;
    const b = (ch + 1) * f;
    const lo = Math.min(a, b);
    const hi = Math.max(a, b);
    const width = hi - lo;
    if (!(width > 0)) {
      add(Math.round(lo), c);
      continue;
    }
    let x = lo;
    while (x < hi) {
      const bin = Math.floor(x + 1e-12);
      const next = Math.min(hi, bin + 1);
      if (next > x) add(bin, (c * (next - x)) / width);
      if (next <= x) break;
      x = next;
    }
  }

  if (acc.size === 0) return spec;
  const keys = Array.from(acc.keys()).sort((a, b) => a - b);
  const iMin = keys[0]!;
  const iMax = keys[keys.length - 1]!;
  const n = iMax - iMin + 1;
  if (n > spec.n * 8 + 32) throw new Error("增益因子过大，修正后道数过多");

  const channel = new Int32Array(n);
  const counts = new Float64Array(n);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ch = iMin + i;
    channel[i] = ch;
    counts[i] = acc.get(ch) ?? 0;
    energy[i] = energyOf(ch, spec.c0, spec.c1, spec.c2);
  }
  return { ...spec, n, channel, counts, energy };
}

export type CalPoint = {
  ch: number;
  energy: number;
};

export type LinearCalFit = {
  c0: number;
  c1: number;
  n: number;
  rms: number;
  r2: number;
  residuals: number[];
};

/** Ordinary least squares: E = C0 + C1 · ch. Requires ≥ 2 distinct channels. */
export function fitLinearCalibration(points: CalPoint[]): LinearCalFit {
  const n = points.length;
  if (n < 2) throw new Error("至少需要 2 个刻度点做线性拟合");
  let sx = 0;
  let sy = 0;
  let sxx = 0;
  let sxy = 0;
  for (const p of points) {
    if (!Number.isFinite(p.ch) || !Number.isFinite(p.energy)) {
      throw new Error("刻度点必须是有效数字");
    }
    sx += p.ch;
    sy += p.energy;
    sxx += p.ch * p.ch;
    sxy += p.ch * p.energy;
  }
  const det = n * sxx - sx * sx;
  if (!(Math.abs(det) > 1e-12 * (Math.abs(sxx) + 1))) {
    throw new Error("刻度点的道址不能全部相同");
  }
  const c1 = (n * sxy - sx * sy) / det;
  const c0 = (sy - c1 * sx) / n;
  if (!Number.isFinite(c0) || !Number.isFinite(c1)) {
    throw new Error("线性刻度拟合失败");
  }
  const meanY = sy / n;
  let ssRes = 0;
  let ssTot = 0;
  const residuals: number[] = [];
  for (const p of points) {
    const pred = c0 + c1 * p.ch;
    const r = pred - p.energy;
    residuals.push(r);
    ssRes += r * r;
    const dy = p.energy - meanY;
    ssTot += dy * dy;
  }
  return {
    c0,
    c1,
    n,
    rms: Math.sqrt(ssRes / n),
    r2: ssTot > 0 ? 1 - ssRes / ssTot : 1,
    residuals,
  };
}

export function parseTxt3(text: string, filename: string): Spectrum {
  const cleaned = text.replace(/^\uFEFF/, "");
  const lines = cleaned.split(/\r?\n/);
  if (lines.length < 4) {
    throw new Error("文件过短，不是有效的 CoMPASS txt3 谱文件");
  }

  const header = lines[0] ?? "";
  const c0 = matchNumber(header, "C0");
  const c1 = matchNumber(header, "C1");
  const c2 = matchNumber(header, "C2") ?? 0;
  if (c0 === null || c1 === null) {
    throw new Error("第一行缺少刻度参数 C0 / C1（需要 C0 = …; C1 = …）");
  }
  const unitMatch = header.match(/unit\s*=\s*([^\s;]+)/i);
  const unit = (unitMatch?.[1] ?? "keV").trim();

  const realLine = lines[1] ?? "";
  const liveLine = lines[2] ?? "";
  const realTimeRaw = realLine.replace(/^\s*RealTime\s*=\s*/i, "").trim();
  const liveTimeRaw = liveLine.replace(/^\s*LiveTime\s*=\s*/i, "").trim();
  if (!/RealTime/i.test(realLine) || !realTimeRaw) {
    throw new Error("第 2 行应为 RealTime = H:MM:SS.mmm");
  }
  if (!/LiveTime/i.test(liveLine) || !liveTimeRaw) {
    throw new Error("第 3 行应为 LiveTime = H:MM:SS.mmm");
  }

  const realTime = parseTimeToSeconds(realTimeRaw);
  const liveTime = parseTimeToSeconds(liveTimeRaw);
  if (liveTime <= 0) throw new Error("LiveTime 必须大于 0，否则无法计算计数率");

  const chBuf: number[] = [];
  const cBuf: number[] = [];
  const eBuf: number[] = [];

  for (let i = 3; i < lines.length; i++) {
    const line = lines[i]?.trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 2) {
      throw new Error(`第 ${i + 1} 行数据列不足: ${line}`);
    }
    const ch = Number(parts[0]);
    const counts = Number(parts[1]);
    if (!Number.isFinite(ch) || !Number.isFinite(counts)) {
      throw new Error(`第 ${i + 1} 行数值无效: ${line}`);
    }
    const energy =
      parts.length >= 3 && Number.isFinite(Number(parts[2]))
        ? Number(parts[2])
        : energyOf(ch, c0, c1, c2);
    chBuf.push(ch);
    cBuf.push(counts);
    eBuf.push(energy);
  }

  if (chBuf.length === 0) throw new Error("谱数据为空");

  const n = chBuf.length;
  return {
    name: filename,
    c0,
    c1,
    c2,
    unit,
    realTime,
    liveTime,
    realTimeRaw,
    liveTimeRaw,
    n,
    channel: Int32Array.from(chBuf),
    counts: Float64Array.from(cBuf),
    energy: Float64Array.from(eBuf),
  };
}

export function sumSpectra(specs: Spectrum[]): Spectrum {
  if (specs.length === 0) throw new Error("没有可相加的谱");
  if (specs.length === 1) return specs[0]!;
  const first = specs[0]!;
  const byCh = new Map<number, number>();
  let live = 0;
  let real = 0;
  for (const s of specs) {
    live += s.liveTime;
    real += s.realTime;
    for (let i = 0; i < s.n; i++) {
      const ch = s.channel[i]!;
      byCh.set(ch, (byCh.get(ch) ?? 0) + (s.counts[i] ?? 0));
    }
  }
  const channels = Array.from(byCh.keys()).sort((a, b) => a - b);
  const n = channels.length;
  const channel = new Int32Array(n);
  const counts = new Float64Array(n);
  const energy = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const ch = channels[i]!;
    channel[i] = ch;
    counts[i] = byCh.get(ch) ?? 0;
    energy[i] = energyOf(ch, first.c0, first.c1, first.c2);
  }
  return {
    ...first,
    name: `${specs.length} 个谱相加`,
    liveTime: live,
    realTime: real,
    liveTimeRaw: formatSeconds(live),
    realTimeRaw: formatSeconds(real),
    n,
    channel,
    counts,
    energy,
  };
}

export function calibMismatch(specs: Spectrum[]): boolean {
  if (specs.length < 2) return false;
  const a = specs[0]!;
  return specs.some((s) => s.c0 !== a.c0 || s.c1 !== a.c1 || s.c2 !== a.c2 || s.unit !== a.unit);
}

export function subtractBackground(meas: Spectrum, bg: Spectrum): NetResult {
  if (bg.liveTime <= 0) throw new Error("本底 LiveTime 必须大于 0");
  const rate = new Map<number, number>();
  for (let i = 0; i < bg.n; i++) {
    rate.set(bg.channel[i]!, bg.counts[i]! / bg.liveTime);
  }

  const net = new Float64Array(meas.n);
  const scaledBg = new Float64Array(meas.n);
  const bgRate = new Float64Array(meas.n);

  for (let i = 0; i < meas.n; i++) {
    const ch = meas.channel[i]!;
    const r = rate.get(ch) ?? 0;
    bgRate[i] = r;
    scaledBg[i] = r * meas.liveTime;
    net[i] = meas.counts[i]! - scaledBg[i]!;
  }

  return { net, scaledBg, bgRate, n: meas.n };
}

export function integral(values: ArrayLike<number>, from = 0, to?: number): number {
  const end = to ?? values.length;
  let s = 0;
  for (let i = from; i < end; i++) s += values[i] ?? 0;
  return s;
}

export function integralInclusive(values: ArrayLike<number>, i0: number, i1: number): number {
  const a = Math.max(0, Math.min(i0, i1));
  const b = Math.min(values.length - 1, Math.max(i0, i1));
  if (b < a) return 0;
  let s = 0;
  for (let i = a; i <= b; i++) s += values[i] ?? 0;
  return s;
}

export function xOfBin(spec: Spectrum, i: number, mode: "channel" | "energy"): number {
  return mode === "energy" ? spec.energy[i]! : spec.channel[i]!;
}

export function indexRangeByX(
  spec: Spectrum,
  mode: "channel" | "energy",
  x0: number,
  x1: number,
): { i0: number; i1: number } {
  const lo = Math.min(x0, x1);
  const hi = Math.max(x0, x1);
  let i0 = spec.n;
  let i1 = -1;
  for (let i = 0; i < spec.n; i++) {
    const x = xOfBin(spec, i, mode);
    if (x >= lo && x <= hi) {
      if (i < i0) i0 = i;
      if (i > i1) i1 = i;
    }
  }
  if (i0 <= i1) return { i0, i1 };
  let bestLo = 0;
  let bestHi = 0;
  let dLo = Infinity;
  let dHi = Infinity;
  for (let i = 0; i < spec.n; i++) {
    const x = xOfBin(spec, i, mode);
    const a = Math.abs(x - lo);
    const b = Math.abs(x - hi);
    if (a < dLo) {
      dLo = a;
      bestLo = i;
    }
    if (b < dHi) {
      dHi = b;
      bestHi = i;
    }
  }
  return { i0: Math.min(bestLo, bestHi), i1: Math.max(bestLo, bestHi) };
}

export function centroidX(
  spec: Spectrum,
  counts: ArrayLike<number>,
  i0: number,
  i1: number,
  mode: "channel" | "energy",
): number | null {
  let w = 0;
  let wx = 0;
  const a = Math.max(0, Math.min(i0, i1));
  const b = Math.min(spec.n - 1, Math.max(i0, i1));
  for (let i = a; i <= b; i++) {
    const c = Math.max(0, counts[i] ?? 0);
    w += c;
    wx += c * xOfBin(spec, i, mode);
  }
  return w > 0 ? wx / w : null;
}

export function peakIndex(counts: ArrayLike<number>, i0: number, i1: number): number {
  let best = i0;
  let m = -Infinity;
  for (let i = i0; i <= i1; i++) {
    const c = counts[i] ?? 0;
    if (c > m) {
      m = c;
      best = i;
    }
  }
  return best;
}

export function suggestPeakRoi(counts: ArrayLike<number>, n: number): { i0: number; i1: number } {
  if (n <= 1) return { i0: 0, i1: Math.max(0, n - 1) };
  let iPeak = 0;
  let m = -Infinity;
  for (let i = 0; i < n; i++) {
    const c = counts[i] ?? 0;
    if (c > m) {
      m = c;
      iPeak = i;
    }
  }
  if (!(m > 0)) return { i0: 0, i1: n - 1 };
  const thr = m * 0.18;
  let i0 = iPeak;
  while (i0 > 0 && (counts[i0 - 1] ?? 0) >= thr) i0--;
  let i1 = iPeak;
  while (i1 < n - 1 && (counts[i1 + 1] ?? 0) >= thr) i1++;
  const pad = Math.max(8, Math.floor((i1 - i0) * 0.25));
  return { i0: Math.max(0, i0 - pad), i1: Math.min(n - 1, i1 + pad) };
}

export const GAUSS_FWHM = 2 * Math.sqrt(2 * Math.log(2));

export type GaussFit = {
  amp: number;
  mu: number;
  sigma: number;
  base: number;
  fwhm: number;
  area: number;
  chi2: number;
  ndf: number;
};

function solve4(H: Float64Array, g: Float64Array): Float64Array | null {
  const a = new Float64Array(H);
  const b = new Float64Array(g);
  const p = [0, 1, 2, 3];
  for (let k = 0; k < 4; k++) {
    let best = k;
    let mag = Math.abs(a[p[k]! * 4 + k]!);
    for (let i = k + 1; i < 4; i++) {
      const v = Math.abs(a[p[i]! * 4 + k]!);
      if (v > mag) {
        mag = v;
        best = i;
      }
    }
    if (mag < 1e-18) return null;
    if (best !== k) {
      const t = p[k]!;
      p[k] = p[best]!;
      p[best] = t;
    }
    const rk = p[k]!;
    const akk = a[rk * 4 + k]!;
    for (let i = k + 1; i < 4; i++) {
      const ri = p[i]!;
      const f = a[ri * 4 + k]! / akk;
      for (let j = k; j < 4; j++) a[ri * 4 + j]! -= f * a[rk * 4 + j]!;
      b[ri]! -= f * b[rk]!;
    }
  }
  const x = new Float64Array(4);
  for (let i = 3; i >= 0; i--) {
    const ri = p[i]!;
    let s = b[ri]!;
    for (let j = i + 1; j < 4; j++) s -= a[ri * 4 + j]! * x[j]!;
    const d = a[ri * 4 + i]!;
    if (Math.abs(d) < 1e-18) return null;
    x[i] = s / d;
  }
  return x;
}

function gaussChi2(
  xs: Float64Array,
  ys: Float64Array,
  A: number,
  mu: number,
  sig: number,
  B: number,
): number {
  const inv = 1 / (2 * sig * sig);
  let s = 0;
  for (let i = 0; i < xs.length; i++) {
    const dx = xs[i]! - mu;
    const f = A * Math.exp(-dx * dx * inv) + B;
    const r = ys[i]! - f;
    const w = 1 / Math.max(Math.abs(ys[i]!), 1);
    s += w * r * r;
  }
  return s;
}

export function fitGaussian(
  channels: ArrayLike<number>,
  counts: ArrayLike<number>,
  i0: number,
  i1: number,
): GaussFit | null {
  const a = Math.max(0, Math.min(i0, i1));
  const b = Math.min(channels.length - 1, Math.max(i0, i1));
  const n = b - a + 1;
  if (n < 5) return null;

  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  let iPeak = 0;
  let yPeak = -Infinity;
  for (let i = 0; i < n; i++) {
    xs[i] = channels[a + i]!;
    ys[i] = counts[a + i] ?? 0;
    if (ys[i]! > yPeak) {
      yPeak = ys[i]!;
      iPeak = i;
    }
  }

  const B0 = 0.5 * (ys[0]! + ys[n - 1]!);
  let A0 = yPeak - B0;
  if (!(A0 > 0)) {
    const ymin = Math.min(ys[0]!, ys[n - 1]!);
    A0 = yPeak - ymin;
  }
  if (!(A0 > 0)) return null;

  const mu0 = xs[iPeak]!;
  const half = B0 + 0.5 * A0;
  let iL = iPeak;
  while (iL > 0 && ys[iL]! >= half) iL--;
  let iR = iPeak;
  while (iR < n - 1 && ys[iR]! >= half) iR++;
  const width = Math.max(xs[iR]! - xs[iL]!, 1);
  let sig0 = Math.max(0.4, width / GAUSS_FWHM);
  const xSpan = Math.max(xs[n - 1]! - xs[0]!, 1);
  sig0 = Math.min(sig0, xSpan);

  let A = A0;
  let mu = mu0;
  let sig = sig0;
  let B = B0;
  let chi = gaussChi2(xs, ys, A, mu, sig, B);
  let lambda = 1e-2;
  const H = new Float64Array(16);
  const g = new Float64Array(4);

  for (let iter = 0; iter < 80; iter++) {
    H.fill(0);
    g.fill(0);
    const inv2 = 1 / (2 * sig * sig);
    const invS2 = 1 / (sig * sig);
    const invS3 = 1 / (sig * sig * sig);
    for (let i = 0; i < n; i++) {
      const dx = xs[i]! - mu;
      const gaus = Math.exp(-dx * dx * inv2);
      const jac0 = gaus;
      const jac1 = A * gaus * dx * invS2;
      const jac2 = A * gaus * dx * dx * invS3;
      const jac3 = 1;
      const w = 1 / Math.max(Math.abs(ys[i]!), 1);
      const r = ys[i]! - (A * gaus + B);
      const jacs = [jac0, jac1, jac2, jac3];
      for (let p = 0; p < 4; p++) {
        g[p]! += w * jacs[p]! * r;
        for (let q = 0; q < 4; q++) H[p * 4 + q]! += w * jacs[p]! * jacs[q]!;
      }
    }
    for (let p = 0; p < 4; p++) H[p * 4 + p]! *= 1 + lambda;
    const step = solve4(H, g);
    if (!step) {
      lambda *= 8;
      if (lambda > 1e8) break;
      continue;
    }
    let A1 = A + step[0]!;
    let mu1 = mu + step[1]!;
    let sig1 = sig + step[2]!;
    let B1 = B + step[3]!;
    if (!(A1 > 0)) A1 = A * 0.5;
    sig1 = Math.min(Math.max(sig1, 0.25), xSpan * 1.5);
    mu1 = Math.min(Math.max(mu1, xs[0]! - xSpan * 0.25), xs[n - 1]! + xSpan * 0.25);
    const chi1 = gaussChi2(xs, ys, A1, mu1, sig1, B1);
    if (chi1 < chi * (1 + 1e-12)) {
      const dA = Math.abs(A1 - A);
      const dMu = Math.abs(mu1 - mu);
      const dS = Math.abs(sig1 - sig);
      A = A1;
      mu = mu1;
      sig = sig1;
      B = B1;
      chi = chi1;
      lambda = Math.max(lambda / 3, 1e-8);
      if (dA < 1e-4 * (Math.abs(A) + 1) && dMu < 1e-4 && dS < 1e-4) break;
    } else {
      lambda *= 6;
      if (lambda > 1e8) break;
    }
  }

  if (!(A > 0) || !(sig > 0) || !Number.isFinite(chi)) return null;
  const ndf = Math.max(1, n - 4);
  return {
    amp: A,
    mu,
    sigma: sig,
    base: B,
    fwhm: GAUSS_FWHM * sig,
    area: A * sig * Math.sqrt(2 * Math.PI),
    chi2: chi,
    ndf,
  };
}

export function gaussY(fit: GaussFit, ch: number): number {
  const d = ch - fit.mu;
  return fit.amp * Math.exp(-(d * d) / (2 * fit.sigma * fit.sigma)) + fit.base;
}

export function deadTimePercent(spec: Spectrum): number {
  if (spec.realTime <= 0) return 0;
  return Math.max(0, (1 - spec.liveTime / spec.realTime) * 100);
}

export function formatTxt3(
  spec: Pick<Spectrum, "c0" | "c1" | "c2" | "unit" | "realTimeRaw" | "liveTimeRaw" | "n" | "channel" | "energy">,
  counts: ArrayLike<number>,
  liveTimeRaw?: string,
  realTimeRaw?: string,
): string {
  const lines = [
    `C0 = ${spec.c0}; C1 = ${spec.c1}; C2 = ${spec.c2}; unit = ${spec.unit}`,
    `RealTime = ${realTimeRaw ?? spec.realTimeRaw}`,
    `LiveTime = ${liveTimeRaw ?? spec.liveTimeRaw}`,
  ];
  for (let i = 0; i < spec.n; i++) {
    const c = counts[i] ?? 0;
    const countStr = Number.isInteger(c) ? String(c) : (c as number).toFixed(6);
    lines.push(`${spec.channel[i]} ${countStr} ${spec.energy[i]}`);
  }
  return lines.join("\n") + "\n";
}

export function formatCsv(
  spec: Spectrum,
  extra?: { scaledBg?: ArrayLike<number>; net?: ArrayLike<number> },
): string {
  const cols = extra
    ? "channel,energy,total,background_scaled,net"
    : "channel,energy,counts";
  const lines = [cols];
  for (let i = 0; i < spec.n; i++) {
    if (extra?.net && extra.scaledBg) {
      lines.push(
        `${spec.channel[i]},${spec.energy[i]},${spec.counts[i]},${extra.scaledBg[i]},${extra.net[i]}`,
      );
    } else {
      lines.push(`${spec.channel[i]},${spec.energy[i]},${spec.counts[i]}`);
    }
  }
  return lines.join("\n") + "\n";
}

export function downloadText(filename: string, text: string, mime = "text/plain"): void {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

export function basename(path: string): string {
  return path.split(/[/\\]/).pop() || path;
}
