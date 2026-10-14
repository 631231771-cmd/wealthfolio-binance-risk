import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  define: { 'process.env.NODE_ENV': JSON.stringify('production') },
  build: {
    target: ['chrome107', 'edge107', 'firefox104', 'safari16'],
    lib: { entry: 'src/addon.tsx', fileName: () => 'addon.js', formats: ['es'] },
    sourcemap: false,
    rollupOptions: { external: ['react', 'react/jsx-runtime', '@wealthfolio/addon-sdk'] }
  }
});
