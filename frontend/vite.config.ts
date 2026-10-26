import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath, URL } from "node:url";
import pkg from "./package.json";

// The workbench version has one source of truth: VERSION at the repo root, which
// the backend reads at startup. scripts/bump_version.py mirrors it into this
// package.json, so the injected build constant can never disagree with the API.
const appVersion = pkg.version;

// 本机私有功能（功能编号 / 隐藏 / 改动记录）放在部署目录旁的「光律本地功能/」，不进仓库。
// 有该目录时把 @local/features 指过去；GitHub 用户没有这个目录，就落到公开占位实现。
const srcDir = fileURLToPath(new URL("./src", import.meta.url));
const localRuntime = fileURLToPath(new URL("../../光律本地功能/featureRuntime.tsx", import.meta.url));
const publicBuild = process.env.GUANGLV_PUBLIC_BUILD === "1";
const useLocalFeatures = !publicBuild && existsSync(localRuntime);

// 本机扩展的 DOM 标注：源码里不保留 data-fid/fid（公开仓库干净），
// 只有本机存在「光律本地功能/dom-patches.json」时，构建期把标注注入进去。
const localPatchFile = fileURLToPath(new URL("../../光律本地功能/dom-patches.json", import.meta.url));
let domPatchCache: { file: string; old: string; new: string }[] | null = null;

function localDomPatches() {
  return {
    name: "guanglv-local-ext-dom",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!code || !/\.(tsx|ts)$/.test(id) || !id.includes("/src/")) return null;
      if (!patchCacheReady && !existsSync(localPatchFile)) {
        patchCacheReady = true;
        domPatchCache = [];
      }
      if (!domPatchCache && existsSync(localPatchFile)) {
        try {
          domPatchCache = JSON.parse(readFileSync(localPatchFile, "utf-8"));
        } catch {
          domPatchCache = [];
        }
        patchCacheReady = true;
      }
      if (!domPatchCache || !domPatchCache.length) return null;
      const name = id.slice(id.lastIndexOf("/") + 1).split("?")[0];
      const rows = domPatchCache.filter((r) => r.file === name);
      if (!rows.length) return null;
      let out = code;
      for (const r of rows) {
        const count = out.split(r.old).length - 1;
        if (count !== 1) {
          throw new Error(`[本机扩展] ${name} 标注注入未唯一匹配（${count} 次）：${r.old.slice(0, 60).replace(/\n/g, " ")}`);
        }
        out = out.replace(r.old, r.new);
      }
      return { code: out, map: null };
    },
  };
}
let patchCacheReady = false;

export default defineConfig({
  define: { __APP_VERSION__: JSON.stringify(appVersion) },
  plugins: [useLocalFeatures ? localDomPatches() : null, react()].filter(Boolean) as any,
  resolve: {
    alias: [
      { find: "@app", replacement: srcDir },
      {
        find: "@local/ext",
        replacement: useLocalFeatures ? localRuntime : fileURLToPath(new URL("./src/localExt.tsx", import.meta.url)),
      },
    ],
  },
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8010",
      "/files": "http://127.0.0.1:8010",
    },
  },
  preview: { host: "0.0.0.0" },
});
