require("esbuild").buildSync({
  entryPoints: ["src/webview/index.tsx"],
  bundle: true,
  outfile: "media/chat.js",
  platform: "browser",
  target: ["chrome120"],
  minify: true,
  sourcemap: true,
});

require("esbuild").buildSync({
  entryPoints: ["src/core/schemaValidation.ts"],
  bundle: true,
  outfile: "out/core/schemaValidation.js",
  platform: "node",
  target: ["node18"],
  format: "cjs",
  minify: true,
  sourcemap: true,
});
