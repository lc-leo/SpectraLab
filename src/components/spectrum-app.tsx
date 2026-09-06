"use client";

import { useEffect, useMemo, useRef, useState, type RefObject } from "react";
import { Toaster, toast } from "sonner";
import {
  Download,
  Eraser,
  FileUp,
  Layers,
  Plus,
  RotateCcw,
  Ruler,
  Scan,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { SpectrumPlot, exportPlotPng, type CursorInfo, type PlotSeries } from "@/components/spectrum-plot";
import {
  applyCalibration,
  basename,
  centroidX,
  deadTimePercent,
  downloadText,
  energyOf,
  fitGaussian,
  fitLinearCalibration,
  formatCsv,
  formatSeconds,
  formatTxt3,
  indexRangeByX,
  integral,
  integralInclusive,
  parseTxt3,
  peakIndex,
  subtractBackground,
  suggestPeakRoi,
  sumSpectra,
  calibMismatch,
  xOfBin,
  type GaussFit,
  type LinearCalFit,
  type NetResult,
  type Spectrum,
} from "@/lib/spectrum";

type PlotMode = "net" | "overlay";
type XMode = "channel" | "energy";

function isStandaloneFile(): boolean {
  if (typeof window === "undefined") return false;
  const { protocol, pathname } = window.location;
  return protocol === "file:" || pathname.endsWith("SpectraLab.html");
}

async function readFile(file: File): Promise<Spectrum> {
  const text = await file.text();
  return parseTxt3(text, file.name);
}

function parseCoeff(raw: string): number | null {
  const v = Number(raw.trim());
  return Number.isFinite(v) ? v : null;
}

function formatCoeff(v: number): string {
  if (!Number.isFinite(v)) return "";
  const abs = Math.abs(v);
  if (abs !== 0 && (abs < 1e-4 || abs >= 1e6)) return v.toExponential(6);
  const s = v.toFixed(6);
  return s.replace(/\.?0+$/, "") || "0";
}

function CoeffField({
  id,
  label,
  hint,
  value,
  onChange,
  onCommit,
}: {
  id: string;
  label: string;
  hint: string;
  value: string;
  onChange: (v: string) => void;
  onCommit: () => void;
}) {
  const invalid = value.trim() !== "" && parseCoeff(value) === null;
  return (
    <label htmlFor={id} className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-0.5 text-[11px] text-muted">{hint}</div>
      <input
        id={id}
        type="text"
        inputMode="decimal"
        autoComplete="off"
        spellCheck={false}
        value={value}
        aria-invalid={invalid}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onCommit}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            onCommit();
            (e.target as HTMLInputElement).blur();
          }
        }}
        className={`mt-1.5 h-11 w-full rounded-[var(--radius-sm)] border bg-bg px-2.5 font-mono text-sm tabular text-fg outline-none transition-colors duration-[var(--motion-quick)] focus:ring-2 focus:ring-ring ${
          invalid
            ? "border-danger focus:border-danger"
            : "border-border focus:border-border-strong"
        }`}
      />
    </label>
  );
}

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wider text-subtle">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[13px] tabular text-fg" title={hint ?? value}>
        {value}
      </div>
    </div>
  );
}

function FileCard({
  title,
  spec,
  onPick,
  inputRef,
  acceptNote,
}: {
  title: string;
  spec: Spectrum | null;
  onPick: (f: File) => void;
  inputRef: RefObject<HTMLInputElement | null>;
  acceptNote: string;
}) {
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-surface-2/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted">{title}</div>
        <Button
          size="sm"
          variant="secondary"
          onClick={() => inputRef.current?.click()}
          className="h-9"
        >
          <FileUp className="size-3.5" />
          导入
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".txt3,.txt,.dat,.spe"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f) onPick(f);
          }}
        />
      </div>
      {spec ? (
        <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
          <Stat label="文件" value={spec.name} />
          <Stat label="道数" value={String(spec.n)} />
          <Stat label="LiveTime" value={formatSeconds(spec.liveTime)} hint={spec.liveTimeRaw} />
          <Stat label="RealTime" value={formatSeconds(spec.realTime)} hint={spec.realTimeRaw} />
          <Stat label="总计数" value={Math.round(integral(spec.counts)).toLocaleString()} />
          <Stat
            label="死时间"
            value={`${deadTimePercent(spec).toFixed(3)} %`}
          />
          <Stat
            label="文件刻度"
            value={`C0=${spec.c0}  C1=${spec.c1}`}
            hint={`C2=${spec.c2}  unit=${spec.unit}`}
          />
          <Stat label="单位" value={spec.unit} />
        </div>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-subtle">{acceptNote}</p>
      )}
    </div>
  );
}

function MeasCard({
  runs,
  spec,
  onReplace,
  onAppend,
  onRemove,
  replaceRef,
  appendRef,
}: {
  runs: Spectrum[];
  spec: Spectrum | null;
  onReplace: (files: File[]) => void;
  onAppend: (files: File[]) => void;
  onRemove: (index: number) => void;
  replaceRef: RefObject<HTMLInputElement | null>;
  appendRef: RefObject<HTMLInputElement | null>;
}) {
  const take = (list: FileList | null, fn: (files: File[]) => void) => {
    if (!list || list.length === 0) return;
    fn(Array.from(list));
  };
  return (
    <div className="rounded-[var(--radius-md)] border border-border bg-surface-2/60 p-3">
      <div className="flex items-center justify-between gap-2">
        <div className="text-xs font-medium text-muted">测量谱</div>
        <div className="flex gap-1.5">
          <Button size="sm" variant="secondary" onClick={() => replaceRef.current?.click()} className="h-9">
            <FileUp className="size-3.5" />
            导入
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => appendRef.current?.click()}
            className="h-9"
            disabled={runs.length === 0}
            title="追加后按道相加，LiveTime / RealTime 同步相加"
          >
            <Plus className="size-3.5" />
            追加
          </Button>
        </div>
        <input
          ref={replaceRef}
          type="file"
          multiple
          accept=".txt3,.txt,.dat,.spe"
          className="hidden"
          onChange={(e) => {
            take(e.target.files, onReplace);
            e.target.value = "";
          }}
        />
        <input
          ref={appendRef}
          type="file"
          multiple
          accept=".txt3,.txt,.dat,.spe"
          className="hidden"
          onChange={(e) => {
            take(e.target.files, onAppend);
            e.target.value = "";
          }}
        />
      </div>
      {spec ? (
        <>
          <div className="mt-3 grid grid-cols-2 gap-x-3 gap-y-2">
            <Stat label="文件" value={spec.name} />
            <Stat label="道数" value={String(spec.n)} />
            <Stat label="LiveTime" value={formatSeconds(spec.liveTime)} hint={spec.liveTimeRaw} />
            <Stat label="RealTime" value={formatSeconds(spec.realTime)} hint={spec.realTimeRaw} />
            <Stat label="总计数" value={Math.round(integral(spec.counts)).toLocaleString()} />
            <Stat label="死时间" value={`${deadTimePercent(spec).toFixed(3)} %`} />
            <Stat
              label="文件刻度"
              value={`C0=${spec.c0}  C1=${spec.c1}`}
              hint={`C2=${spec.c2}  unit=${spec.unit}`}
            />
            <Stat label="单位" value={spec.unit} />
          </div>
          {runs.length > 1 ? (
            <ul className="mt-3 space-y-1 border-t border-border pt-2">
              {runs.map((r, i) => (
                <li key={`${r.name}-${i}`} className="flex items-center gap-2 text-[11px] text-muted">
                  <span className="min-w-0 flex-1 truncate" title={r.name}>
                    {i + 1}. {r.name}
                  </span>
                  <span className="shrink-0 font-mono tabular">{formatSeconds(r.liveTime)}</span>
                  <button
                    type="button"
                    className="inline-flex size-7 items-center justify-center rounded-[var(--radius-xs)] text-subtle hover:bg-surface hover:text-fg"
                    onClick={() => onRemove(i)}
                    title="从相加中移除"
                  >
                    <X className="size-3.5" />
                  </button>
                </li>
              ))}
            </ul>
          ) : null}
        </>
      ) : (
        <p className="mt-2 text-xs leading-relaxed text-subtle">
          可一次选择多个 txt3。计数按道相加，LiveTime 与 RealTime 同步相加。
        </p>
      )}
    </div>
  );
}

export function SpectrumApp() {
  const [bg, setBg] = useState<Spectrum | null>(null);
  const [measRuns, setMeasRuns] = useState<Spectrum[]>([]);
  const [plotMode, setPlotMode] = useState<PlotMode>("overlay");
  const [xMode, setXMode] = useState<XMode>("energy");
  const [yLog, setYLog] = useState(true);
  const [cursor, setCursor] = useState<CursorInfo>(null);
  const [plotEpoch, setPlotEpoch] = useState(0);
  const [c0Draft, setC0Draft] = useState("");
  const [c1Draft, setC1Draft] = useState("");
  const [cal, setCal] = useState<{ c0: number; c1: number; c2: number } | null>(null);
  const [calPoints, setCalPoints] = useState<{ id: number; ch: number; energy: number }[]>([]);
  const [calChDraft, setCalChDraft] = useState("");
  const [calEDraft, setCalEDraft] = useState("");
  const [calFit, setCalFit] = useState<LinearCalFit | null>(null);
  const calPointId = useRef(1);
  const [roi, setRoi] = useState<{ i0: number; i1: number } | null>(null);
  const [roiFromDraft, setRoiFromDraft] = useState("");
  const [roiToDraft, setRoiToDraft] = useState("");
  const [gaussFit, setGaussFit] = useState<GaussFit | null>(null);
  const bgInput = useRef<HTMLInputElement>(null);
  const measReplaceRef = useRef<HTMLInputElement>(null);
  const measAppendRef = useRef<HTMLInputElement>(null);
  const standalone = isStandaloneFile();

  const meas = useMemo(() => (measRuns.length ? sumSpectra(measRuns) : null), [measRuns]);

  const fileCalSrc = meas ?? bg;

  useEffect(() => {
    const src = meas ?? bg;
    if (!src) {
      setC0Draft("");
      setC1Draft("");
      setCal(null);
      return;
    }
    setC0Draft(String(src.c0));
    setC1Draft(String(src.c1));
    setCal({ c0: src.c0, c1: src.c1, c2: src.c2 });
  }, [meas, bg]);

  const net: NetResult | null = useMemo(() => {
    if (!bg || !meas) return null;
    try {
      return subtractBackground(meas, bg);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "本底扣除失败");
      return null;
    }
  }, [bg, meas]);

  const calWarn =
    bg && meas && (bg.c0 !== meas.c0 || bg.c1 !== meas.c1 || bg.c2 !== meas.c2)
      ? "两谱刻度系数不同，仍按道址对齐扣除。"
      : calibMismatch(measRuns)
        ? "测量谱之间刻度系数不同，仍按道址相加。"
        : null;

  const commitCal = (c0Raw = c0Draft, c1Raw = c1Draft, noisy = true) => {
    const c0 = parseCoeff(c0Raw);
    const c1 = parseCoeff(c1Raw);
    if (c0 === null || c1 === null) {
      if (noisy) toast.error("C0 / C1 必须是有效数字");
      return false;
    }
    const c2 = cal?.c2 ?? fileCalSrc?.c2 ?? 0;
    setCal({ c0, c1, c2 });
    setC0Draft(String(c0));
    setC1Draft(String(c1));
    setCalFit(null);
    return true;
  };

  const restoreFileCal = () => {
    if (!fileCalSrc) return;
    setC0Draft(String(fileCalSrc.c0));
    setC1Draft(String(fileCalSrc.c1));
    setCal({ c0: fileCalSrc.c0, c1: fileCalSrc.c1, c2: fileCalSrc.c2 });
    setCalFit(null);
  };

  const addCalPoint = (chRaw = calChDraft, eRaw = calEDraft) => {
    const ch = parseCoeff(chRaw);
    const energy = parseCoeff(eRaw);
    if (ch === null || energy === null) {
      toast.error("峰位（道址）和能量必须是有效数字");
      return;
    }
    setCalPoints((prev) => {
      const existing = prev.findIndex((p) => Math.abs(p.ch - ch) < 1e-6);
      if (existing >= 0) {
        const next = prev.slice();
        next[existing] = { ...next[existing]!, ch, energy };
        return next;
      }
      return [...prev, { id: calPointId.current++, ch, energy }];
    });
    setCalChDraft("");
    setCalEDraft("");
  };

  const fillPeakAsCalCh = () => {
    if (gaussFit) {
      setCalChDraft(gaussFit.mu.toFixed(3));
      return;
    }
    if (plotSpec && roi) {
      const counts = net?.net ?? plotSpec.counts;
      const iPeak = peakIndex(counts, roi.i0, roi.i1);
      setCalChDraft(String(plotSpec.channel[iPeak]!));
      return;
    }
    toast.error("请先框选 ROI，或对峰做高斯拟合后再填入峰位");
  };

  const fitCalFromPoints = () => {
    try {
      const fit = fitLinearCalibration(calPoints);
      setCal({ c0: fit.c0, c1: fit.c1, c2: 0 });
      setC0Draft(formatCoeff(fit.c0));
      setC1Draft(formatCoeff(fit.c1));
      setCalFit(fit);
      toast.success(
        `线性刻度 C0=${formatCoeff(fit.c0)}  C1=${formatCoeff(fit.c1)}  RMS=${fit.rms.toFixed(3)}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "线性刻度拟合失败");
    }
  };

  const measCal = useMemo(() => {
    if (!meas) return null;
    if (!cal) return meas;
    return applyCalibration(meas, cal.c0, cal.c1, cal.c2);
  }, [meas, cal]);

  const bgCal = useMemo(() => {
    if (!bg) return null;
    if (!cal) return bg;
    return applyCalibration(bg, cal.c0, cal.c1, cal.c2);
  }, [bg, cal]);

  const plotSpec = measCal ?? bgCal;
  const calCustom =
    Boolean(
      fileCalSrc &&
        cal &&
        (cal.c0 !== fileCalSrc.c0 || cal.c1 !== fileCalSrc.c1 || cal.c2 !== fileCalSrc.c2),
    );

  useEffect(() => {
    if (!plotSpec) {
      setRoi(null);
      setRoiFromDraft("");
      setRoiToDraft("");
      return;
    }
    const n = plotSpec.n;
    setRoi((prev) => {
      if (!prev) return null;
      const i0 = Math.min(n - 1, Math.max(0, prev.i0));
      const i1 = Math.min(n - 1, Math.max(0, prev.i1));
      if (i0 === prev.i0 && i1 === prev.i1) return prev;
      return { i0: Math.min(i0, i1), i1: Math.max(i0, i1) };
    });
  }, [plotSpec]);

  useEffect(() => {
    if (!roi || !plotSpec) return;
    const a = xOfBin(plotSpec, roi.i0, xMode);
    const b = xOfBin(plotSpec, roi.i1, xMode);
    const fmt = (v: number) => (xMode === "channel" ? String(Math.round(v)) : v.toFixed(2));
    setRoiFromDraft(fmt(Math.min(a, b)));
    setRoiToDraft(fmt(Math.max(a, b)));
  }, [roi, plotSpec, xMode]);

  const applyRoiFromDrafts = (fromRaw = roiFromDraft, toRaw = roiToDraft) => {
    if (!plotSpec) return;
    const a = parseCoeff(fromRaw);
    const b = parseCoeff(toRaw);
    if (a === null || b === null) return;
    setRoi(indexRangeByX(plotSpec, xMode, a, b));
  };

  const setRoiFromX = (min: number, max: number) => {
    if (!plotSpec) return;
    setRoi(indexRangeByX(plotSpec, xMode, min, max));
  };

  const autoPeakRoi = () => {
    if (!plotSpec) return;
    const counts = net?.net ?? plotSpec.counts;
    setRoi(suggestPeakRoi(counts, plotSpec.n));
  };

  const clearRoi = () => {
    setRoi(null);
    setRoiFromDraft("");
    setRoiToDraft("");
    setGaussFit(null);
  };

  useEffect(() => {
    setGaussFit(null);
  }, [roi?.i0, roi?.i1]);

  const runGaussFit = () => {
    if (!plotSpec || !roi) {
      toast.error("请先框选 ROI");
      return;
    }
    const counts = net?.net ?? plotSpec.counts;
    const fit = fitGaussian(plotSpec.channel, counts, roi.i0, roi.i1);
    if (!fit) {
      toast.error("高斯拟合失败，请把 ROI 缩到单个峰附近");
      return;
    }
    setGaussFit(fit);
  };

  const peakStats = useMemo(() => {
    if (!plotSpec || !roi) return null;
    const { i0, i1 } = roi;
    const total = meas ? integralInclusive(meas.counts, i0, i1) : integralInclusive(plotSpec.counts, i0, i1);
    const bgVal = net ? integralInclusive(net.scaledBg, i0, i1) : null;
    const netVal = net ? integralInclusive(net.net, i0, i1) : null;
    const countsForPeak = net?.net ?? plotSpec.counts;
    const iPeak = peakIndex(countsForPeak, i0, i1);
    const cent = centroidX(plotSpec, countsForPeak, i0, i1, xMode);
    const live = meas?.liveTime ?? plotSpec.liveTime;
    return {
      i0,
      i1,
      ch0: plotSpec.channel[i0]!,
      ch1: plotSpec.channel[i1]!,
      e0: plotSpec.energy[i0]!,
      e1: plotSpec.energy[i1]!,
      total,
      bgVal,
      netVal,
      iPeak,
      peakCh: plotSpec.channel[iPeak]!,
      peakE: plotSpec.energy[iPeak]!,
      centroid: cent,
      rate: netVal !== null && live > 0 ? netVal / live : null,
      bins: i1 - i0 + 1,
    };
  }, [plotSpec, roi, meas, net, xMode]);

  const gaussStats = useMemo(() => {
    if (!gaussFit || !plotSpec) return null;
    const muE = energyOf(gaussFit.mu, plotSpec.c0, plotSpec.c1, plotSpec.c2);
    const slope = plotSpec.c1 + 2 * plotSpec.c2 * gaussFit.mu;
    const fwhmE = Math.abs(slope) * gaussFit.fwhm;
    return {
      peak: xMode === "energy" ? muE : gaussFit.mu,
      fwhm: xMode === "energy" ? fwhmE : gaussFit.fwhm,
      area: gaussFit.area,
      unit: xMode === "energy" ? plotSpec.unit : "ch",
      chi2nu: gaussFit.chi2 / gaussFit.ndf,
      peakCh: gaussFit.mu,
      peakE: muE,
      fwhmCh: gaussFit.fwhm,
      fwhmE,
    };
  }, [gaussFit, plotSpec, xMode]);

  const roiX =
    roi && plotSpec
      ? {
          min: Math.min(xOfBin(plotSpec, roi.i0, xMode), xOfBin(plotSpec, roi.i1, xMode)),
          max: Math.max(xOfBin(plotSpec, roi.i0, xMode), xOfBin(plotSpec, roi.i1, xMode)),
        }
      : null;

  const series: PlotSeries[] = useMemo(() => {
    if (!plotSpec) return [];
    const totalColor =
      typeof window !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--color-series-total").trim() ||
          "#6cb4e8"
        : "#6cb4e8";
    const bgColor =
      typeof window !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--color-series-bg").trim() ||
          "#c17f7a"
        : "#c17f7a";
    const netColor =
      typeof window !== "undefined"
        ? getComputedStyle(document.documentElement).getPropertyValue("--color-series-net").trim() ||
          "#6ecf9a"
        : "#6ecf9a";

    if (meas && net && plotMode === "overlay") {
      return [
        { id: "meas", label: "测量谱", color: totalColor, counts: meas.counts, fill: true },
        { id: "bg", label: "本底 (× LiveTime)", color: bgColor, counts: net.scaledBg },
        { id: "net", label: "净谱", color: netColor, counts: net.net },
      ];
    }
    if (meas && net && plotMode === "net") {
      return [{ id: "net", label: "净谱", color: netColor, counts: net.net, fill: true }];
    }
    if (meas) {
      return [{ id: "meas", label: "测量谱", color: totalColor, counts: meas.counts, fill: true }];
    }
    if (bg) {
      return [{ id: "bg", label: "本底", color: bgColor, counts: bg.counts, fill: true }];
    }
    return [];
  }, [plotSpec, meas, bg, net, plotMode]);

  const ingestMeas = async (files: File[], mode: "replace" | "append") => {
    try {
      const parsed: Spectrum[] = [];
      for (const f of files) parsed.push(await readFile(f));
      if (parsed.length === 0) return;
      if (mode === "replace") {
        setRoi(null);
        setRoiFromDraft("");
        setRoiToDraft("");
      }
      const next = mode === "append" ? [...measRuns, ...parsed] : parsed;
      setMeasRuns(next);
      const live = next.reduce((s, x) => s + x.liveTime, 0);
      toast.success(
        next.length > 1
          ? `测量谱 ${next.length} 个已按道相加 · LiveTime ${formatSeconds(live)} · ${next[0]!.n} 道`
          : `测量谱已载入：${parsed[0]!.n} 道，LiveTime ${formatSeconds(parsed[0]!.liveTime)}`,
      );
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "文件解析失败");
    }
  };

  const handlePick = async (kind: "bg" | "meas", file: File) => {
    try {
      const spec = await readFile(file);
      if (kind === "bg") {
        setBg(spec);
        toast.success(`本底已载入：${spec.n} 道，LiveTime ${formatSeconds(spec.liveTime)}`);
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "文件解析失败");
    }
  };

  const exportNet = () => {
    if (!meas || !net || !measCal) {
      toast.error("需要同时载入本底和测量谱");
      return;
    }
    const text = formatTxt3(measCal, net.net);
    downloadText(`${basename(meas.name).replace(/\.[^.]+$/, "")}_net.txt3`, text);
  };

  const exportCsv = () => {
    if (!meas || !measCal) {
      toast.error("请先导入测量谱");
      return;
    }
    const text = formatCsv(measCal, net ? { scaledBg: net.scaledBg, net: net.net } : undefined);
    downloadText(`${basename(meas.name).replace(/\.[^.]+$/, "")}.csv`, text, "text/csv");
  };

  return (
    <div className="flex h-dvh flex-col overflow-hidden bg-bg text-fg">
      <Toaster
        theme="dark"
        position="top-right"
        toastOptions={{
          style: {
            background: "#1a2028",
            border: "1px solid #252b34",
            color: "#e6e9ee",
            fontFamily: "IBM Plex Sans, sans-serif",
          },
        }}
      />

      <header className="flex shrink-0 items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2.5">
            <h1 className="text-lg font-semibold tracking-tight text-fg">Spectra Lab</h1>
            <span className="hidden text-xs text-subtle sm:inline">CoMPASS txt3 · 本底扣除</span>
          </div>
          <p className="mt-0.5 text-xs text-muted">
            每道本底计数率 × 测量 LiveTime，再从测量谱扣除
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {standalone ? null : (
            <a href="/SpectraLab.html" download="SpectraLab.html" className="inline-flex">
              <Button size="sm" variant="primary">
                <Download className="size-3.5" />
                <span className="hidden sm:inline">下载离线版</span>
                <span className="sm:hidden">离线</span>
              </Button>
            </a>
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-hidden">
        <aside className="order-2 flex w-full shrink-0 flex-col gap-3 overflow-y-auto border-b border-border p-4 lg:order-1 lg:h-full lg:w-[320px] lg:border-b-0 lg:border-r">
          <FileCard
            title="本底谱"
            spec={bg}
            onPick={(f) => void handlePick("bg", f)}
            inputRef={bgInput}
            acceptNote="导入 CoMPASS txt3。自动用计数 / LiveTime 得到每道本底计数率。"
          />
          <MeasCard
            runs={measRuns}
            spec={meas}
            onReplace={(files) => void ingestMeas(files, "replace")}
            onAppend={(files) => void ingestMeas(files, "append")}
            onRemove={(index) => setMeasRuns((prev) => prev.filter((_, i) => i !== index))}
            replaceRef={measReplaceRef}
            appendRef={measAppendRef}
          />

          {calWarn ? (
            <p className="rounded-[var(--radius-sm)] border border-warn/30 bg-warn/10 px-3 py-2 text-xs text-warn">
              {calWarn}
            </p>
          ) : null}

          <fieldset className="rounded-[var(--radius-md)] border border-border p-3">
            <legend className="px-1 text-xs font-medium text-muted">绘制</legend>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
              <input
                type="radio"
                name="plotMode"
                className="size-4 accent-ok"
                checked={plotMode === "net"}
                onChange={() => setPlotMode("net")}
                disabled={!net}
              />
              仅净谱
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
              <input
                type="radio"
                name="plotMode"
                className="size-4 accent-ok"
                checked={plotMode === "overlay"}
                onChange={() => setPlotMode("overlay")}
              />
              <Layers className="size-3.5 text-muted" />
              本底 + 净谱 + 测量谱
            </label>
          </fieldset>

          <fieldset className="rounded-[var(--radius-md)] border border-border p-3">
            <legend className="px-1 text-xs font-medium text-muted">坐标轴</legend>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
              <input
                type="radio"
                name="xMode"
                className="size-4 accent-ok"
                checked={xMode === "channel"}
                onChange={() => setXMode("channel")}
              />
              道址 Channel
            </label>
            <label className="flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
              <input
                type="radio"
                name="xMode"
                className="size-4 accent-ok"
                checked={xMode === "energy"}
                onChange={() => setXMode("energy")}
              />
              能量 Energy
              {plotSpec ? ` (${plotSpec.unit})` : ""}
            </label>
            <label className="mt-1 flex min-h-11 cursor-pointer items-center gap-2.5 text-sm">
              <input
                type="checkbox"
                className="size-4 accent-ok"
                checked={yLog}
                onChange={(e) => setYLog(e.target.checked)}
              />
              Y 轴对数
            </label>
          </fieldset>

          {xMode === "energy" && plotSpec ? (
            <fieldset className="rounded-[var(--radius-md)] border border-border p-3">
              <legend className="px-1 text-xs font-medium text-muted">
                <span className="inline-flex items-center gap-1.5">
                  <Ruler className="size-3.5" />
                  能量刻度
                </span>
              </legend>
              <p className="font-mono text-[11px] text-muted">
                E = C0 + C1 · ch
                {plotSpec.c2 ? ` + C2 · ch²` : ""}
                <span className="text-subtle"> （{plotSpec.unit}）</span>
              </p>
              {calCustom ? (
                <p className="mt-1 text-[11px] text-ok">已按自定义系数重绘能谱</p>
              ) : (
                <p className="mt-1 text-[11px] text-subtle">
                  文件值 C0={fileCalSrc?.c0}　C1={fileCalSrc?.c1}
                </p>
              )}
              <div className="mt-3 grid grid-cols-2 gap-2">
                <CoeffField
                  id="cal-c0"
                  label="C0"
                  hint="常数项"
                  value={c0Draft}
                  onChange={(v) => {
                    setC0Draft(v);
                    const c0 = parseCoeff(v);
                    const c1 = parseCoeff(c1Draft);
                    if (c0 !== null && c1 !== null) {
                      setCal({ c0, c1, c2: cal?.c2 ?? plotSpec.c2 });
                      setCalFit(null);
                    }
                  }}
                  onCommit={() => commitCal(c0Draft, c1Draft, false)}
                />
                <CoeffField
                  id="cal-c1"
                  label="C1"
                  hint={`一次项 · ${plotSpec.unit}/ch`}
                  value={c1Draft}
                  onChange={(v) => {
                    setC1Draft(v);
                    const c0 = parseCoeff(c0Draft);
                    const c1 = parseCoeff(v);
                    if (c0 !== null && c1 !== null) {
                      setCal({ c0, c1, c2: cal?.c2 ?? plotSpec.c2 });
                      setCalFit(null);
                    }
                  }}
                  onCommit={() => commitCal(c0Draft, c1Draft, false)}
                />
              </div>
              <Button
                variant="ghost"
                className="mt-2 h-11 w-full"
                disabled={!calCustom}
                onClick={restoreFileCal}
              >
                <RotateCcw className="size-3.5" />
                恢复文件刻度
              </Button>

              <div className="mt-3 border-t border-border pt-3">
                <p className="text-[11px] font-medium text-muted">刻度点</p>
                <p className="mt-0.5 text-[11px] leading-relaxed text-subtle">
                  峰位用道址，能量为已知值。≥2 点后最小二乘拟合 E = C0 + C1 · ch（C2 置 0）
                </p>
                {calPoints.length ? (
                  <ul className="mt-2 space-y-1">
                    {calPoints.map((p) => {
                      const pred = cal
                        ? energyOf(p.ch, cal.c0, cal.c1, cal.c2)
                        : null;
                      const d = pred !== null ? pred - p.energy : null;
                      return (
                        <li
                          key={p.id}
                          className="flex items-center gap-1.5 font-mono text-[11px] tabular text-fg"
                        >
                          <span className="min-w-0 flex-1 truncate">
                            ch {p.ch} → {p.energy} {plotSpec.unit}
                            {d !== null ? (
                              <span className="text-subtle">
                                {" "}
                                Δ{d >= 0 ? "+" : ""}
                                {d.toFixed(3)}
                              </span>
                            ) : null}
                          </span>
                          <button
                            type="button"
                            className="inline-flex size-8 shrink-0 items-center justify-center rounded-[var(--radius-sm)] text-muted hover:bg-surface-2 hover:text-fg"
                            aria-label={`删除刻度点 ${p.ch}`}
                            onClick={() =>
                              setCalPoints((prev) => prev.filter((x) => x.id !== p.id))
                            }
                          >
                            <X className="size-3.5" />
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                ) : null}
                <div className="mt-2 grid grid-cols-2 gap-2">
                  <label htmlFor="cal-pt-ch" className="min-w-0">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-subtle">
                      峰位
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">道址 ch</div>
                    <input
                      id="cal-pt-ch"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      value={calChDraft}
                      onChange={(e) => setCalChDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCalPoint();
                        }
                      }}
                      className="mt-1.5 h-11 w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2.5 font-mono text-sm tabular text-fg outline-none focus:border-border-strong focus:ring-2 focus:ring-ring"
                    />
                  </label>
                  <label htmlFor="cal-pt-e" className="min-w-0">
                    <div className="text-[11px] font-medium uppercase tracking-wider text-subtle">
                      能量
                    </div>
                    <div className="mt-0.5 text-[11px] text-muted">{plotSpec.unit}</div>
                    <input
                      id="cal-pt-e"
                      type="text"
                      inputMode="decimal"
                      autoComplete="off"
                      spellCheck={false}
                      value={calEDraft}
                      onChange={(e) => setCalEDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          addCalPoint();
                        }
                      }}
                      className="mt-1.5 h-11 w-full rounded-[var(--radius-sm)] border border-border bg-bg px-2.5 font-mono text-sm tabular text-fg outline-none focus:border-border-strong focus:ring-2 focus:ring-ring"
                    />
                  </label>
                </div>
                <div className="mt-2 flex flex-col gap-1.5">
                  <Button variant="ghost" className="h-11 w-full" onClick={() => addCalPoint()}>
                    <Plus className="size-3.5" />
                    添加刻度点
                  </Button>
                  <Button
                    variant="ghost"
                    className="h-11 w-full"
                    disabled={!gaussFit && !roi}
                    onClick={fillPeakAsCalCh}
                  >
                    {gaussFit ? "填入拟合峰位" : "填入 ROI 峰位"}
                  </Button>
                  <Button
                    className="h-11 w-full"
                    disabled={calPoints.length < 2}
                    onClick={fitCalFromPoints}
                  >
                    最小二乘拟合
                  </Button>
                </div>
                {calFit ? (
                  <p className="mt-2 font-mono text-[11px] leading-relaxed text-ok">
                    C0={formatCoeff(calFit.c0)}　C1={formatCoeff(calFit.c1)}
                    <br />
                    RMS={calFit.rms.toFixed(4)} {plotSpec.unit}　R²={calFit.r2.toFixed(6)}　C2=0
                  </p>
                ) : null}
              </div>
            </fieldset>
          ) : null}

          <div className="flex flex-col gap-2">
            <Button onClick={exportNet} disabled={!net} className="h-11 w-full">
              导出净谱 txt3
            </Button>
            <Button onClick={exportCsv} disabled={!meas} className="h-11 w-full">
              导出 CSV
            </Button>
            <Button
              onClick={() => exportPlotPng("spectrum.png")}
              disabled={!plotSpec}
              className="h-11 w-full"
            >
              导出谱图 PNG
            </Button>
            <Button
              variant="ghost"
              className="h-11 w-full"
              onClick={() => {
                setBg(null);
                setMeasRuns([]);
                setCursor(null);
                setRoi(null);
                setRoiFromDraft("");
                setRoiToDraft("");
                setGaussFit(null);
                setCalPoints([]);
                setCalChDraft("");
                setCalEDraft("");
                setCalFit(null);
              }}
            >
              <Eraser className="size-3.5" />
              清空谱
            </Button>
          </div>

          <div className="rounded-[var(--radius-md)] border border-border p-3 text-[11px] leading-relaxed text-subtle">
            <p className="font-medium text-muted">用法</p>
            <ol className="mt-1 list-decimal space-y-1 pl-4">
              <li>导入本底谱 txt3</li>
              <li>导入测量谱，可多选或「追加」；计数与 LiveTime / RealTime 按道相加</li>
              <li>默认显示全部道址；F7 缩小、F8 放大，也可滚轮缩放</li>
              <li>能量轴下可改 C0 / C1，或添加刻度点（峰位道址，已知能量）做最小二乘线性刻度</li>
              <li>填写 ROI，或 Alt/Ctrl+拖动框选；扣除结果显示该区间</li>
              <li>框选单个峰后点「高斯拟合」，得到拟合峰位、FWHM、峰面积</li>
            </ol>
            <p className="mt-2 font-medium text-muted">离线单机</p>
            <p className="mt-1">
              {standalone
                ? "当前已是离线版：本文件可单独拷贝使用，导入本地 txt3 即可，不需要网络。"
                : "右上角「下载离线版」得到一个 HTML 文件。拷到 U 盘，在无网络电脑上用 Chrome 或 Edge 双击打开即可。谱文件通过「导入」从本机选择，全程不联网。"}
            </p>
            <p className="mt-2 font-medium text-muted">算法</p>
            <p className="mt-1 font-mono text-[11px] text-muted">
              rᵢ = Nᵇᵍᵢ / t_liveᵇᵍ
              <br />
              Nⁿᵉᵗᵢ = Nᵐᵉᵃˢᵢ − rᵢ · t_liveᵐᵉᵃˢ
            </p>
          </div>
        </aside>

        <section className="order-1 flex min-h-0 min-w-0 flex-1 flex-col lg:order-2">
          <div className="relative min-h-[280px] w-full flex-1 bg-plot">
            <SpectrumPlot
              key={`${plotEpoch}-${plotMode}-${xMode}`}
              spec={plotSpec}
              series={series}
              xMode={xMode}
              yLog={yLog}
              roi={roiX}
              gaussFit={gaussFit}
              onRoi={({ min, max }) => setRoiFromX(min, max)}
              onCursor={setCursor}
              emptyHint="导入本底谱与测量谱"
            />
            <button
              type="button"
              className="absolute right-3 top-3 inline-flex h-9 items-center gap-1.5 rounded-[var(--radius-sm)] border border-border bg-surface/90 px-2.5 text-xs text-muted hover:text-fg"
              onClick={() => setPlotEpoch((n) => n + 1)}
              title="复位视窗"
            >
              <RotateCcw className="size-3.5" />
              复位
            </button>
          </div>

          <div className="shrink-0 border-t border-border bg-surface-2/70 px-4 py-3">
            <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
              <div className="flex items-center gap-1.5 text-xs font-medium text-muted">
                <Scan className="size-3.5" />
                ROI
              </div>
              <p className="text-[11px] text-subtle">
                {plotSpec
                  ? xMode === "energy"
                    ? `能量区间（${plotSpec.unit}）`
                    : "道址区间"
                  : "导入谱后填写或框选"}
              </p>
              <label className="flex items-center gap-1.5 text-[11px] text-subtle">
                左
                <input
                  id="roi-from"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!plotSpec}
                  value={roiFromDraft}
                  onChange={(e) => setRoiFromDraft(e.target.value)}
                  onBlur={() => applyRoiFromDrafts()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyRoiFromDrafts();
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="h-9 w-[7.5rem] rounded-[var(--radius-sm)] border border-border bg-bg px-2 font-mono text-sm tabular text-fg outline-none focus:border-border-strong focus:ring-2 focus:ring-ring disabled:opacity-50"
                />
              </label>
              <label className="flex items-center gap-1.5 text-[11px] text-subtle">
                右
                <input
                  id="roi-to"
                  type="text"
                  inputMode="decimal"
                  autoComplete="off"
                  spellCheck={false}
                  disabled={!plotSpec}
                  value={roiToDraft}
                  onChange={(e) => setRoiToDraft(e.target.value)}
                  onBlur={() => applyRoiFromDrafts()}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      applyRoiFromDrafts();
                      (e.target as HTMLInputElement).blur();
                    }
                  }}
                  className="h-9 w-[7.5rem] rounded-[var(--radius-sm)] border border-border bg-bg px-2 font-mono text-sm tabular text-fg outline-none focus:border-border-strong focus:ring-2 focus:ring-ring disabled:opacity-50"
                />
              </label>
              <div className="flex flex-wrap gap-1.5">
                <Button variant="ghost" className="h-9" disabled={!plotSpec} onClick={autoPeakRoi}>
                  自动找峰
                </Button>
                <Button
                  variant="ghost"
                  className="h-9"
                  disabled={!plotSpec}
                  onClick={() => {
                    if (!plotSpec) return;
                    setRoi({ i0: 0, i1: plotSpec.n - 1 });
                  }}
                >
                  全谱
                </Button>
                <Button variant="ghost" className="h-9" disabled={!roi} onClick={clearRoi}>
                  清除
                </Button>
                <Button variant="secondary" className="h-9" disabled={!roi} onClick={runGaussFit}>
                  高斯拟合
                </Button>
              </div>
            </div>
            {plotSpec && peakStats ? (
              <>
                <p className="mt-2 text-[11px] text-subtle">
                  道 {peakStats.ch0}–{peakStats.ch1} · {peakStats.e0.toFixed(1)}–
                  {peakStats.e1.toFixed(1)} {plotSpec.unit} · {peakStats.bins} 道
                </p>
                <div className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 sm:grid-cols-3 lg:grid-cols-6">
                  <Stat
                    label="峰位"
                    value={
                      xMode === "energy"
                        ? `${peakStats.peakE.toFixed(2)} ${plotSpec.unit}`
                        : `ch ${peakStats.peakCh}`
                    }
                    hint={`ch ${peakStats.peakCh}  ·  ${peakStats.peakE.toFixed(2)} ${plotSpec.unit}`}
                  />
                  <Stat
                    label="质心"
                    value={
                      peakStats.centroid === null
                        ? "—"
                        : xMode === "energy"
                          ? `${peakStats.centroid.toFixed(2)} ${plotSpec.unit}`
                          : peakStats.centroid.toFixed(1)
                    }
                  />
                  <Stat label="总计数" value={peakStats.total.toFixed(1)} />
                  {peakStats.bgVal !== null ? (
                    <Stat label="本底" value={peakStats.bgVal.toFixed(1)} />
                  ) : null}
                  {peakStats.netVal !== null ? (
                    <Stat
                      label="净计数"
                      value={peakStats.netVal.toFixed(1)}
                      hint={
                        peakStats.rate !== null ? `${peakStats.rate.toFixed(4)} cps` : undefined
                      }
                    />
                  ) : null}
                  {peakStats.rate !== null ? (
                    <Stat label="净计数率" value={`${peakStats.rate.toFixed(4)} cps`} />
                  ) : null}
                </div>
              </>
            ) : (
              <p className="mt-2 text-[11px] text-subtle">
                默认显示全谱、不框选 ROI。填写左右边界或 Alt/Ctrl+拖动框选后显示该区间结果。
              </p>
            )}
            {gaussStats && plotSpec ? (
              <div className="mt-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 text-[12px] text-muted">
                <span className="font-medium">高斯拟合</span>
                <span className="font-mono text-[11px] text-subtle">
                  y = A exp(−(x−μ)² / 2σ²) + B
                </span>
                <span title={`ch ${gaussStats.peakCh.toFixed(2)}  ·  ${gaussStats.peakE.toFixed(3)} ${plotSpec.unit}`}>
                  拟合峰位{" "}
                  <span className="font-mono tabular text-fg">
                    {xMode === "energy"
                      ? `${gaussStats.peak.toFixed(3)} ${plotSpec.unit}`
                      : gaussStats.peak.toFixed(2)}
                  </span>
                </span>
                <span title={`ch ${gaussStats.fwhmCh.toFixed(2)}  ·  ${gaussStats.fwhmE.toFixed(3)} ${plotSpec.unit}`}>
                  FWHM{" "}
                  <span className="font-mono tabular text-fg">
                    {xMode === "energy"
                      ? `${gaussStats.fwhm.toFixed(3)} ${plotSpec.unit}`
                      : `${gaussStats.fwhm.toFixed(2)} ch`}
                  </span>
                </span>
                <span title="A·σ·√(2π)，不含本底">
                  峰面积 <span className="font-mono tabular text-fg">{gaussStats.area.toFixed(1)}</span>
                </span>
                <span className="text-[11px] text-subtle">χ²/ν = {gaussStats.chi2nu.toFixed(2)}</span>
              </div>
            ) : null}
          </div>

          <footer className="flex shrink-0 flex-wrap items-center gap-x-5 gap-y-1 border-t border-border bg-surface px-4 py-2 font-mono text-[12px] tabular text-muted">
            {plotSpec ? (
              <span>
                道 <span className="text-fg">{plotSpec.channel[0]}</span>–
                <span className="text-fg">{plotSpec.channel[plotSpec.n - 1]}</span>
                <span className="text-subtle"> / {plotSpec.n}</span>
              </span>
            ) : null}
            {xMode === "energy" && plotSpec ? (
              <>
                <span>
                  C0 <span className="text-fg">{plotSpec.c0}</span>
                </span>
                <span>
                  C1 <span className="text-fg">{plotSpec.c1}</span>
                </span>
              </>
            ) : null}
            {cursor && plotSpec ? (
              <>
                <span>
                  ch <span className="text-fg">{cursor.channel}</span>
                </span>
                <span>
                  E <span className="text-fg">{cursor.energy.toFixed(3)}</span> {plotSpec.unit}
                </span>
                {cursor.values.meas !== undefined ? (
                  <span>
                    测量 <span className="text-fg">{cursor.values.meas.toFixed(2)}</span>
                  </span>
                ) : null}
                {cursor.values.bg !== undefined ? (
                  <span>
                    本底 <span className="text-fg">{cursor.values.bg.toFixed(2)}</span>
                  </span>
                ) : null}
                {cursor.values.net !== undefined ? (
                  <span>
                    净 <span className="text-series-net">{cursor.values.net.toFixed(2)}</span>
                  </span>
                ) : null}
              </>
            ) : (
              <span>将光标移到谱线上读取 · F7 缩小 · F8 放大</span>
            )}
          </footer>
        </section>
      </div>
    </div>
  );
}
