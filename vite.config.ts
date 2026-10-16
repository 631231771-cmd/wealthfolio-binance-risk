import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// @ts-expect-error Node build helper has no declarations; never shipped as runtime code.
import {sourceFingerprint} from './scripts/source-fingerprint.mjs';

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production'), __WRISK_BUILD__:JSON.stringify(sourceFingerprint().slice(0,8)) },
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    lib: { entry: 'src/addon.tsx', fileName: () => 'addon.js', formats: ['es'] },
    sourcemap: false,
    rollupOptions: { external: ['react', 'react/jsx-runtime', '@wealthfolio/addon-sdk'] }
  }
});
