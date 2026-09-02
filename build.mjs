/**
 * dsh-v-explorer 客户端构建：
 * esbuild 把 src/client.jsx 打包成 factory 形式的 lib/client.js
 * （window.__ModuleLoader__.load 包裹；react / @deepseek-ai/* 全部 external，
 *  由 DSH client-modules 的引导基线提供；markdown-it 打进包内）。
 *
 * Markdown 预览主题：`src/markdown-reader-pro.css` 是**单一来源**。
 * 构建时读取它，经 transformReaderCss（src/reader-css.transform.mjs）做作用域
 * 变换后，通过虚拟模块 `virtual:dve-reader-css` 注入 src/client.jsx——
 * 改主题只需改那个 css 文件然后重新 `pnpm build`。
 */
import { readFileSync, writeFileSync } from "node:fs";
import * as esbuild from "esbuild";
import { transformReaderCss } from "./src/reader-css.transform.mjs";

const banner = `window.__ModuleLoader__.load({ id: "dsh-v-explorer", factory: (require) => {
"use strict";
var module = { exports: {} };
var exports = module.exports;`;

const footer = `return module.exports;
} });`;

/** 虚拟模块：把变换后的 Reader Pro CSS 以字符串形式 import 进 client.jsx。 */
const readerCssPlugin = {
  name: "dve-reader-css",
  setup(build) {
    build.onResolve({ filter: /^virtual:dve-reader-css$/ }, (args) => ({ path: args.path, namespace: "reader-css" }));
    build.onLoad({ filter: /.*/, namespace: "reader-css" }, () => ({
      contents: transformReaderCss(readFileSync(new URL("./src/markdown-reader-pro.css", import.meta.url), "utf8")),
      loader: "text"
    }));
  }
};

await esbuild.build({
  entryPoints: ["src/client.jsx"],
  bundle: true,
  format: "cjs",
  platform: "browser",
  target: "es2022",
  jsx: "automatic",
  outfile: "lib/client.js",
  banner: { js: banner },
  footer: { js: footer },
  external: ["react", "react/jsx-runtime", "react-dom", "@deepseek-ai/*"],
  plugins: [readerCssPlugin],
  minify: true,
  legalComments: "none",
  logLevel: "info"
});

/* 「引用」token 共享模块：纯 ESM、零依赖，原样复制给宿主端
   （lib/index.js import "./ref-shared.js"）；客户端侧已由 esbuild 打进包内。 */
writeFileSync(
  new URL("./lib/ref-shared.js", import.meta.url),
  readFileSync(new URL("./src/ref-shared.mjs", import.meta.url))
);
