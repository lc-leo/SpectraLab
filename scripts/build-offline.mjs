#!/usr/bin/env node
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { build } from "vite";

const root = join(import.meta.dirname, "..");
const dist = join(root, "dist-offline");
const outFile = join(root, "public", "SpectraLab.html");

await build({
  configFile: join(root, "vite.offline.config.ts"),
  logLevel: "error",
});

const files = readdirSync(dist);
const jsName = files.find((f) => f.endsWith(".js"));
const cssName = files.find((f) => f.endsWith(".css"));
if (!jsName) throw new Error("offline build produced no JS");

const js = readFileSync(join(dist, jsName), "utf8").replaceAll("</script", "<\\/script");
const css = cssName
  ? readFileSync(join(dist, cssName), "utf8").replaceAll("</style", "<\\/style")
  : "";

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<meta name="color-scheme" content="dark"/>
<title>Spectra Lab · 能谱分析器</title>
<style>
${css}
html,body,#app{min-height:100dvh;margin:0}
</style>
</head>
<body>
<div id="app"></div>
<script>
${js}
SpectraLab.mount(document.getElementById("app"));
</script>
</body>
</html>
`;

mkdirSync(join(root, "public"), { recursive: true });
writeFileSync(outFile, html);
console.log(`[offline] wrote ${outFile} (${(html.length / 1024).toFixed(0)} KB)`);
