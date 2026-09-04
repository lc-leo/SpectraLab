import { useCallback, useEffect, useRef, useState } from "react";
import type { GaussFit, Spectrum } from "@/lib/spectrum";
import { energyOf, gaussY } from "@/lib/spectrum";

export type PlotSeries = {
  id: string;
  label: string;
  color: string;
  counts: ArrayLike<number>;
  fill?: boolean;
};

export type CursorInfo = {
  index: number;
  channel: number;
  energy: number;
  values: Record<string, number>;
} | null;

type Props = {
  spec: Spectrum | null;
  series: PlotSeries[];
  xMode: "channel" | "energy";
  yLog: boolean;
  onCursor?: (c: CursorInfo) => void;
  emptyHint: string;
  roi?: { min: number; max: number } | null;
  onRoi?: (r: { min: number; max: number }) => void;
  gaussFit?: GaussFit | null;
};

type View = { min: number; max: number };

function readCssColor(name: string, fallback: string): string {
  if (typeof window === "undefined") return fallback;
  const v = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return v || fallback;
}

function niceNum(range: number, round: boolean): number {
  const exp = Math.floor(Math.log10(Math.max(range, 1e-12)));
  const f = range / 10 ** exp;
  let nf: number;
  if (round) {
    if (f < 1.5) nf = 1;
    else if (f < 3) nf = 2;
    else if (f < 7) nf = 5;
    else nf = 10;
  } else if (f <= 1) nf = 1;
  else if (f <= 2) nf = 2;
  else if (f <= 5) nf = 5;
  else nf = 10;
  return nf * 10 ** exp;
}

function ticks(min: number, max: number, count: number): number[] {
  if (!(max > min)) return [min];
  const range = niceNum(max - min, false);
  const step = niceNum(range / Math.max(count - 1, 1), true);
  const tMin = Math.ceil(min / step) * step;
  const out: number[] = [];
  for (let v = tMin; v <= max + step * 0.01; v += step) out.push(Number(v.toPrecision(12)));
  return out;
}

function logTicks(min: number, max: number): number[] {
  const lo = Math.max(min, 1e-3);
  const hi = Math.max(max, lo * 10);
  const out: number[] = [];
  const start = Math.floor(Math.log10(lo));
  const end = Math.ceil(Math.log10(hi));
  for (let e = start; e <= end; e++) {
    const b = 10 ** e;
    if (b >= lo * 0.999 && b <= hi * 1.001) out.push(b);
  }
  return out.length ? out : [lo, hi];
}

function formatTick(v: number): string {
  if (!Number.isFinite(v)) return "";
  const a = Math.abs(v);
  if (a >= 10000 || (a > 0 && a < 0.01)) return v.toExponential(1);
  if (a >= 100) return v.toFixed(0);
  if (Number.isInteger(v)) return String(v);
  return v.toFixed(a >= 10 ? 1 : 2);
}

function xOf(spec: Spectrum, i: number, mode: "channel" | "energy"): number {
  return mode === "energy" ? spec.energy[i]! : spec.channel[i]!;
}

function fullRange(spec: Spectrum, mode: "channel" | "energy"): View {
  const n = spec.n;
  if (n < 2) {
    const v = xOf(spec, 0, mode);
    return { min: v - 0.5, max: v + 0.5 };
  }
  const last = n - 1;
  const x0 = xOf(spec, 0, mode);
  const x1 = xOf(spec, 1, mode);
  const xn1 = xOf(spec, last, mode);
  const xn2 = xOf(spec, Math.max(0, last - 1), mode);
  const d0 = (x1 - x0) / 2;
  const d1 = last > 0 ? (xn1 - xn2) / 2 : d0;
  let min = x0 - d0;
  let max = xn1 + d1;
  if (max < min) {
    const t = min;
    min = max;
    max = t;
  }
  return { min, max };
}

function yTransform(v: number, yLog: boolean): number {
  if (!yLog) return v;
  return Math.log10(Math.max(v, 0.5));
}

export function SpectrumPlot({ spec, series, xMode, yLog, onCursor, emptyHint, roi, onRoi, gaussFit }: Props) {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const viewRef = useRef<View | null>(null);
  const [view, setView] = useState<View | null>(null);
  const dragRef = useRef<null | { kind: "pan" | "box" | "roi"; x0: number; y0: number; v0: number }>(null);
  const [box, setBox] = useState<null | { x0: number; x1: number }>(null);
  const hoverX = useRef<number | null>(null);

  useEffect(() => {
    viewRef.current = null;
    setView(null);
  }, [spec?.name, spec?.n, xMode]);

  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const cssW = wrap.clientWidth;
    const cssH = wrap.clientHeight;
    if (cssW < 8 || cssH < 8) return;
    if (canvas.width !== Math.floor(cssW * dpr) || canvas.height !== Math.floor(cssH * dpr)) {
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      canvas.style.width = `${cssW}px`;
      canvas.style.height = `${cssH}px`;
    }
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    const bg = readCssColor("--color-plot", "#0c0f14");
    const fg = readCssColor("--color-fg", "#e6e9ee");
    const muted = readCssColor("--color-muted", "#8b939e");
    const grid = readCssColor("--color-plot-grid", "#1c232c");
    const axis = readCssColor("--color-plot-axis", "#8b939e");

    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, cssW, cssH);

    const pad = { l: 72, r: 16, t: 28, b: 52 };
    const overviewH = 36;
    const gap = 10;
    const plotW = cssW - pad.l - pad.r;
    const plotH = cssH - pad.t - pad.b - overviewH - gap;
    if (plotW < 20 || plotH < 20) return;

    if (!spec || series.length === 0) {
      ctx.fillStyle = muted;
      ctx.font = "13px IBM Plex Sans, sans-serif";
      ctx.textAlign = "center";
      ctx.fillText(emptyHint, cssW / 2, cssH / 2);
      return;
    }

    const full = fullRange(spec, xMode);
    let v = viewRef.current ?? view ?? full;
    v = {
      min: Math.max(v.min, full.min),
      max: Math.min(v.max, full.max),
    };
    if (!(v.max > v.min)) v = full;
    const xMin = v.min;
    const xMax = Math.max(v.max, v.min + 1e-9);

    let yMax = 1;
    for (const s of series) {
      for (let i = 0; i < spec.n; i++) {
        const x = xOf(spec, i, xMode);
        if (x < xMin || x > xMax) continue;
        const c = s.counts[i] ?? 0;
        if (c > yMax) yMax = c;
      }
    }
    yMax = yMax * 1.12;
    const yMin = yLog ? 0.5 : 0;
    const yTMin = yTransform(yMin, yLog);
    const yTMax = yTransform(yMax, yLog);

    const xToPx = (x: number) => pad.l + ((x - xMin) / (xMax - xMin)) * plotW;
    const yToPx = (c: number) => {
      const t = yTransform(c, yLog);
      return pad.t + plotH - ((t - yTMin) / (yTMax - yTMin)) * plotH;
    };

    ctx.save();
    ctx.beginPath();
    ctx.rect(pad.l, pad.t, plotW, plotH);
    ctx.clip();

    const xt = ticks(xMin, xMax, Math.max(4, Math.floor(plotW / 90)));
    const yt = yLog ? logTicks(yMin, yMax) : ticks(0, yMax, Math.max(4, Math.floor(plotH / 56)));
    ctx.strokeStyle = grid;
    ctx.lineWidth = 1;
    for (const t of xt) {
      const px = xToPx(t);
      ctx.beginPath();
      ctx.moveTo(px, pad.t);
      ctx.lineTo(px, pad.t + plotH);
      ctx.stroke();
    }
    for (const t of yt) {
      const py = yToPx(t);
      ctx.beginPath();
      ctx.moveTo(pad.l, py);
      ctx.lineTo(pad.l + plotW, py);
      ctx.stroke();
    }

    const binsPerPx = spec.n / plotW;
    const useAgg = (xMax - xMin) / (full.max - full.min) * spec.n > plotW * 1.4;

    for (const s of series) {
      ctx.strokeStyle = s.color;
      ctx.lineWidth = s.fill ? 1.1 : 1.35;
      ctx.beginPath();
      let started = false;
      const baseline = yToPx(yLog ? 0.5 : 0);

      if (useAgg || binsPerPx > 1.2) {
        let lastPx = -1;
        let maxC = 0;
        let accX0 = 0;
        ctx.beginPath();
        let pathStarted = false;
        for (let i = 0; i < spec.n; i++) {
          const x = xOf(spec, i, xMode);
          if (x < xMin || x > xMax) continue;
          const px = xToPx(x);
          const c = s.counts[i] ?? 0;
          if (lastPx < 0) {
            lastPx = px;
            accX0 = px;
            maxC = c;
            continue;
          }
          if (Math.floor(px) === Math.floor(lastPx)) {
            if (c > maxC) maxC = c;
          } else {
            const y1 = yToPx(maxC);
            if (s.fill) {
              ctx.fillStyle = s.color + "55";
              ctx.fillRect(accX0, y1, Math.max(1, px - accX0), baseline - y1);
            }
            if (!pathStarted) {
              ctx.moveTo(accX0, y1);
              pathStarted = true;
            } else {
              ctx.lineTo(accX0, y1);
            }
            ctx.lineTo(px, y1);
            lastPx = px;
            accX0 = px;
            maxC = c;
          }
        }
        ctx.stroke();
      } else {
        for (let i = 0; i < spec.n; i++) {
          const x = xOf(spec, i, xMode);
          const xNext = i + 1 < spec.n ? xOf(spec, i + 1, xMode) : x + (x - xOf(spec, Math.max(0, i - 1), xMode));
          if (xNext < xMin || x > xMax) continue;
          const c = s.counts[i] ?? 0;
          const x0 = xToPx(x - (xNext - x) / 2);
          const x1 = xToPx(x + (xNext - x) / 2);
          const y = yToPx(c);
          if (s.fill) {
            ctx.fillStyle = s.color + "40";
            ctx.fillRect(x0, y, Math.max(1, x1 - x0), baseline - y);
            ctx.beginPath();
            ctx.moveTo(x0, y);
            ctx.lineTo(x1, y);
            ctx.stroke();
          } else {
            if (!started) {
              ctx.moveTo(x0, y);
              started = true;
            } else {
              ctx.lineTo(x0, y);
            }
            ctx.lineTo(x1, y);
          }
        }
        if (!s.fill && started) ctx.stroke();
      }
    }

    if (roi && roi.max > roi.min) {
      const xa = xToPx(roi.min);
      const xb = xToPx(roi.max);
      const left = Math.min(xa, xb);
      const width = Math.max(2, Math.abs(xb - xa));
      ctx.fillStyle = "rgba(110, 207, 154, 0.14)";
      ctx.fillRect(left, pad.t, width, plotH);
      ctx.strokeStyle = "rgba(110, 207, 154, 0.75)";
      ctx.lineWidth = 1.25;
      ctx.beginPath();
      ctx.moveTo(left, pad.t);
      ctx.lineTo(left, pad.t + plotH);
      ctx.moveTo(left + width, pad.t);
      ctx.lineTo(left + width, pad.t + plotH);
      ctx.stroke();
      ctx.fillStyle = readCssColor("--color-series-net", "#6ecf9a");
      ctx.font = "500 11px IBM Plex Sans, sans-serif";
      ctx.textAlign = "left";
      ctx.textBaseline = "top";
      ctx.fillText("ROI", left + 6, pad.t + 6);
    }

    if (gaussFit && spec) {
      const fitColor = readCssColor("--color-series-fit", "#e8c36a");
      const chLo = gaussFit.mu - 4 * gaussFit.sigma;
      const chHi = gaussFit.mu + 4 * gaussFit.sigma;
      const step = Math.max(0.2, (chHi - chLo) / 240);
      ctx.strokeStyle = fitColor;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      let started = false;
      for (let ch = chLo; ch <= chHi + 1e-9; ch += step) {
        const x = xMode === "energy" ? energyOf(ch, spec.c0, spec.c1, spec.c2) : ch;
        if (x < xMin || x > xMax) continue;
        const y = gaussY(gaussFit, ch);
        const px = xToPx(x);
        const py = yToPx(y);
        if (!started) {
          ctx.moveTo(px, py);
          started = true;
        } else {
          ctx.lineTo(px, py);
        }
      }
      if (started) ctx.stroke();
      const muX = xMode === "energy" ? energyOf(gaussFit.mu, spec.c0, spec.c1, spec.c2) : gaussFit.mu;
      if (muX >= xMin && muX <= xMax) {
        const px = xToPx(muX);
        ctx.strokeStyle = fitColor;
        ctx.lineWidth = 1;
        ctx.setLineDash([4, 3]);
        ctx.beginPath();
        ctx.moveTo(px, pad.t);
        ctx.lineTo(px, pad.t + plotH);
        ctx.stroke();
        ctx.setLineDash([]);
      }
    }

    if (box) {
      const xa = Math.min(box.x0, box.x1);
      const xb = Math.max(box.x0, box.x1);
      ctx.fillStyle = "rgba(110, 180, 232, 0.12)";
      ctx.fillRect(xa, pad.t, xb - xa, plotH);
      ctx.strokeStyle = "rgba(110, 180, 232, 0.7)";
      ctx.strokeRect(xa, pad.t, xb - xa, plotH);
    }

    if (hoverX.current !== null) {
      const hx = hoverX.current;
      ctx.strokeStyle = "rgba(230,233,238,0.25)";
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(hx, pad.t);
      ctx.lineTo(hx, pad.t + plotH);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();

    ctx.strokeStyle = axis;
    ctx.lineWidth = 1;
    ctx.strokeRect(pad.l, pad.t, plotW, plotH);

    ctx.fillStyle = muted;
    ctx.font = "11px IBM Plex Mono, monospace";
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    for (const t of xt) {
      const px = xToPx(t);
      if (px < pad.l - 4 || px > pad.l + plotW + 4) continue;
      ctx.fillStyle = axis;
      ctx.fillRect(px, pad.t + plotH, 1, 4);
      ctx.fillStyle = muted;
      ctx.fillText(formatTick(t), px, pad.t + plotH + 7);
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of yt) {
      const py = yToPx(t);
      if (py < pad.t - 2 || py > pad.t + plotH + 2) continue;
      ctx.fillStyle = axis;
      ctx.fillRect(pad.l - 4, py, 4, 1);
      ctx.fillStyle = muted;
      ctx.fillText(formatTick(t), pad.l - 8, py);
    }

    ctx.fillStyle = fg;
    ctx.font = "500 12px IBM Plex Sans, sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "alphabetic";
    const xTitle = xMode === "energy" ? `Energy (${spec.unit})` : "Channel";
    ctx.fillText(xTitle, pad.l + plotW / 2, cssH - overviewH - 6);

    if (xMode === "energy") {
      ctx.fillStyle = muted;
      ctx.font = "11px IBM Plex Mono, monospace";
      ctx.textAlign = "right";
      ctx.textBaseline = "top";
      const c2Part = spec.c2 ? ` + ${spec.c2}·ch²` : "";
      ctx.fillText(`E = ${spec.c0} + ${spec.c1}·ch${c2Part}`, pad.l + plotW - 8, pad.t + 8);
    }

    ctx.save();
    ctx.translate(14, pad.t + plotH / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.fillText("Counts", 0, 0);
    ctx.restore();

    let lx = pad.l + 10;
    const ly = pad.t - 14;
    ctx.font = "500 11px IBM Plex Sans, sans-serif";
    ctx.textAlign = "left";
    ctx.textBaseline = "middle";
    for (const s of series) {
      ctx.fillStyle = s.color;
      ctx.fillRect(lx, ly - 4, 12, 8);
      ctx.fillStyle = muted;
      ctx.fillText(s.label, lx + 16, ly);
      lx += 16 + ctx.measureText(s.label).width + 16;
    }
    if (gaussFit) {
      const fitColor = readCssColor("--color-series-fit", "#e8c36a");
      ctx.fillStyle = fitColor;
      ctx.fillRect(lx, ly - 4, 12, 8);
      ctx.fillStyle = muted;
      ctx.fillText("Gauss", lx + 16, ly);
    }

    const ovY = cssH - overviewH;
    const ovX = pad.l;
    const ovW = plotW;
    ctx.fillStyle = readCssColor("--color-surface", "#12161c");
    ctx.fillRect(ovX, ovY, ovW, overviewH);
    ctx.strokeStyle = grid;
    ctx.strokeRect(ovX, ovY, ovW, overviewH);

    const primary = series[0];
    if (primary) {
      let pMax = 1;
      for (let i = 0; i < spec.n; i++) {
        const c = primary.counts[i] ?? 0;
        if (c > pMax) pMax = c;
      }
      ctx.fillStyle = primary.color + "99";
      const step = Math.max(1, Math.floor(spec.n / ovW));
      for (let px = 0; px < ovW; px++) {
        const i0 = Math.floor((px / ovW) * spec.n);
        const i1 = Math.min(spec.n, i0 + step);
        let m = 0;
        for (let i = i0; i < i1; i++) m = Math.max(m, primary.counts[i] ?? 0);
        const h = (m / pMax) * (overviewH - 4);
        ctx.fillRect(ovX + px, ovY + overviewH - 2 - h, 1, h);
      }
    }
    const vx0 = ovX + ((xMin - full.min) / (full.max - full.min)) * ovW;
    const vx1 = ovX + ((xMax - full.min) / (full.max - full.min)) * ovW;
    ctx.fillStyle = "rgba(110,180,232,0.12)";
    ctx.fillRect(vx0, ovY, Math.max(2, vx1 - vx0), overviewH);
    ctx.strokeStyle = "rgba(110,180,232,0.7)";
    ctx.strokeRect(vx0, ovY, Math.max(2, vx1 - vx0), overviewH);

    (canvas as HTMLCanvasElement & { __layout?: Layout }).__layout = {
      pad,
      plotW,
      plotH,
      overviewH,
      ovY,
      ovX,
      ovW,
      xMin,
      xMax,
      full,
      xToPx,
      cssW,
      cssH,
    };
  }, [spec, series, xMode, yLog, view, box, emptyHint, roi, gaussFit]);

  type Layout = {
    pad: { l: number; r: number; t: number; b: number };
    plotW: number;
    plotH: number;
    overviewH: number;
    ovY: number;
    ovX: number;
    ovW: number;
    xMin: number;
    xMax: number;
    full: View;
    xToPx: (x: number) => number;
    cssW: number;
    cssH: number;
  };

  useEffect(() => {
    draw();
  }, [draw]);

  useEffect(() => {
    const wrap = wrapRef.current;
    if (!wrap) return;
    const ro = new ResizeObserver(() => draw());
    ro.observe(wrap);
    return () => ro.disconnect();
  }, [draw]);

  const layoutOf = (): Layout | null => {
    const c = canvasRef.current as (HTMLCanvasElement & { __layout?: Layout }) | null;
    return c?.__layout ?? null;
  };

  const pxToX = (px: number, L: Layout) =>
    L.xMin + ((px - L.pad.l) / L.plotW) * (L.xMax - L.xMin);

  const applyZoom = (factor: number, anchorX?: number) => {
    if (!spec) return;
    const L = layoutOf();
    if (!L) return;
    const full = L.full;
    const x =
      anchorX ??
      (hoverX.current !== null ? pxToX(hoverX.current, L) : (L.xMin + L.xMax) / 2);
    let min = x - (x - L.xMin) * factor;
    let max = x + (L.xMax - x) * factor;
    if (max - min < (full.max - full.min) * 0.002) return;
    if (min < full.min) min = full.min;
    if (max > full.max) max = full.max;
    const next = { min, max };
    viewRef.current = next;
    setView(next);
  };

  const zoomRef = useRef(applyZoom);
  zoomRef.current = applyZoom;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "F7" && e.key !== "F8") return;
      const tag = (e.target as HTMLElement | null)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      e.preventDefault();
      zoomRef.current(e.key === "F7" ? 1.18 : 1 / 1.18);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const nearestIndex = (x: number) => {
    if (!spec) return -1;
    let best = 0;
    let bestD = Infinity;
    for (let i = 0; i < spec.n; i++) {
      const d = Math.abs(xOf(spec, i, xMode) - x);
      if (d < bestD) {
        bestD = d;
        best = i;
      }
    }
    return best;
  };

  const emitCursor = (px: number | null) => {
    hoverX.current = px;
    if (px === null || !spec) {
      onCursor?.(null);
      draw();
      return;
    }
    const L = layoutOf();
    if (!L) return;
    const x = pxToX(px, L);
    const i = nearestIndex(x);
    const values: Record<string, number> = {};
    for (const s of series) values[s.id] = s.counts[i] ?? 0;
    onCursor?.({
      index: i,
      channel: spec.channel[i]!,
      energy: spec.energy[i]!,
      values,
    });
    draw();
  };

  const onPointerDown = (e: React.PointerEvent<HTMLCanvasElement>) => {
    if (!spec) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const py = e.clientY - rect.top;
    const L = layoutOf();
    if (!L) return;
    e.currentTarget.setPointerCapture(e.pointerId);

    if (py >= L.ovY) {
      const full = L.full;
      const x = full.min + ((px - L.ovX) / L.ovW) * (full.max - full.min);
      const span = L.xMax - L.xMin;
      const next = {
        min: Math.max(full.min, x - span / 2),
        max: Math.min(full.max, x + span / 2),
      };
      if (next.max - next.min < span) {
        if (next.min === full.min) next.max = full.min + span;
        if (next.max === full.max) next.min = full.max - span;
      }
      viewRef.current = next;
      setView(next);
      return;
    }

    if (e.altKey || e.ctrlKey || e.metaKey) {
      dragRef.current = { kind: "roi", x0: px, y0: py, v0: 0 };
      setBox({ x0: px, x1: px });
      return;
    }
    if (e.shiftKey) {
      dragRef.current = { kind: "box", x0: px, y0: py, v0: 0 };
      setBox({ x0: px, x1: px });
      return;
    }
    dragRef.current = { kind: "pan", x0: px, y0: py, v0: pxToX(px, L) };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const L = layoutOf();
    if (!L || !spec) return;

    const drag = dragRef.current;
    if (drag?.kind === "box" || drag?.kind === "roi") {
      setBox({ x0: drag.x0, x1: px });
      return;
    }
    if (drag?.kind === "pan") {
      const dx = pxToX(px, L) - pxToX(drag.x0, L);
      const span = L.xMax - L.xMin;
      let min = L.xMin - dx;
      let max = L.xMax - dx;
      const full = L.full;
      if (min < full.min) {
        min = full.min;
        max = full.min + span;
      }
      if (max > full.max) {
        max = full.max;
        min = full.max - span;
      }
      const next = { min, max };
      viewRef.current = next;
      setView(next);
      drag.x0 = px;
      return;
    }

    if (px >= L.pad.l && px <= L.pad.l + L.plotW) emitCursor(px);
    else emitCursor(null);
  };

  const onPointerUp = (e: React.PointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current;
    dragRef.current = null;
    if ((drag?.kind === "box" || drag?.kind === "roi") && spec) {
      const L = layoutOf();
      const rect = e.currentTarget.getBoundingClientRect();
      const px = e.clientX - rect.left;
      setBox(null);
      if (!L) return;
      const a = pxToX(drag.x0, L);
      const b = pxToX(px, L);
      if (Math.abs(px - drag.x0) > 8) {
        const next = { min: Math.min(a, b), max: Math.max(a, b) };
        if (drag.kind === "roi") {
          onRoi?.(next);
        } else {
          viewRef.current = next;
          setView(next);
        }
      }
    }
  };

  const onWheel = (e: React.WheelEvent<HTMLCanvasElement>) => {
    if (!spec) return;
    e.preventDefault();
    const L = layoutOf();
    if (!L) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const px = e.clientX - rect.left;
    const factor = e.deltaY > 0 ? 1.18 : 1 / 1.18;
    applyZoom(factor, pxToX(px, L));
  };

  const onDblClick = () => {
    viewRef.current = null;
    setView(null);
  };

  return (
    <div ref={wrapRef} className="relative h-full min-h-0 w-full bg-plot">
      <canvas
        ref={canvasRef}
        className="block h-full w-full touch-none"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onPointerLeave={() => {
          dragRef.current = null;
          setBox(null);
          emitCursor(null);
        }}
        onWheel={onWheel}
        onDoubleClick={onDblClick}
      />
    </div>
  );
}

export function exportPlotPng(filename: string): void {
  const canvas = document.querySelector("canvas");
  if (!canvas) return;
  canvas.toBlob((blob) => {
    if (!blob) return;
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
  });
}
