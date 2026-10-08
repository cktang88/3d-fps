import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  server: { port: 5173, hmr: process.env.NO_HMR ? false : true, watch: process.env.NO_HMR ? { ignored: ['**/*'] } : undefined },
  build: { target: 'es2022', chunkSizeWarningLimit: 4000, assetsInlineLimit: 0 },
  optimizeDeps: { exclude: ['@dimforge/rapier3d-compat', '@recast-navigation/core', '@recast-navigation/wasm'] },
});
