# Spectra Lab

CoMPASS **txt3** 能谱分析器：本底扣除、多测量谱相加、ROI 积分、高斯拟合。可在无网络的电脑上用单个 HTML 文件运行。

## 离线使用

仓库中的 [`public/SpectraLab.html`](public/SpectraLab.html) 可单独拷贝。用 Chrome 或 Edge 双击打开，导入本机 txt3 即可，全程不需要网络。

## 功能

- 导入本底谱、测量谱（可多选 / 追加，计数与 LiveTime、RealTime 按道相加）
- 按 LiveTime 归一后逐道扣除本底
- 仅净谱，或本底 + 净谱 + 测量谱叠加
- X 轴道址 / 能量（单位取自文件 `unit`）；能量轴可改 C0、C1，或添加刻度点（峰位道址，已知能量）做最小二乘线性刻度
- ROI：填写边界或 Alt/Ctrl+拖动框选；区间计数、峰位、质心
- 高斯拟合：拟合峰位、FWHM、峰面积，并在谱上画曲线
- F7 缩小、F8 放大，滚轮缩放

## txt3 格式

```
C0 = …; C1 = …; C2 = …; unit = keV
RealTime = 0:05:47.474
LiveTime = 0:05:47.474
<道址> <计数> <能量>
```

本底扣除：

\[
r_i = N^{\mathrm{bg}}_i / t_{\mathrm{live}}^{\mathrm{bg}},\quad
N^{\mathrm{net}}_i = N^{\mathrm{meas}}_i - r_i \cdot t_{\mathrm{live}}^{\mathrm{meas}}
\]

高斯模型：\(y = A\exp(-(x-\mu)^2/2\sigma^2)+B\)，峰面积 \(A\sigma\sqrt{2\pi}\)（不含常数本底）。

## 本地开发

需要 Node.js 22+。

```bash
npm install
npm run dev
```

重新生成离线 HTML：

```bash
npm run build:offline
```

示例谱在 `public/samples/`。
