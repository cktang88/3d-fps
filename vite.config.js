import { defineConfig } from 'vite';

// Perf (docs/PERF.md): vendor code is split into separately cacheable chunks that download in parallel
// (three / post FX / physics+nav); game code stays small so most edits only invalidate one chunk.
const VENDOR = [
  ['rapier', /@dimforge/],
  ['three', /node_modules\/three\//],
  ['postfx', /node_modules\/(postprocessing|n8ao)\//],
  ['nav', /@recast-navigation/],
  ['vendor', /node_modules\//],
];

export default defineConfig({
  base: './',
  server: { port: 5173, hmr: process.env.NO_HMR ? false : true, watch: process.env.NO_HMR ? { ignored: ['**/*'] } : undefined },
  build: {
    target: 'es2022', chunkSizeWarningLimit: 4000, assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        codeSplitting: { groups: VENDOR.map(([name, test], i) => ({ name, test, priority: VENDOR.length - i })) },
      },
    },
  },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat', '@recast-navigation/core', '@recast-navigation/wasm'] },
});
