import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// NOTE: `@shared` (packages/shared/src/constants.ts) references `process.env.*`
// for RULE_DEFAULTS. Vite does not provide `process` in the browser, so we
// replace the expression with an empty object — every lookup falls back to the
// hardcoded default (`?? 80` etc.), matching the contract's dev defaults.
export default defineConfig({
  plugins: [react()],
  define: {
    'process.env': '{}',
  },
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      '@shared': path.resolve(__dirname, '../../packages/shared/src/constants.ts'),
    },
  },
  server: { port: 5175, host: true },
  build: { chunkSizeWarningLimit: 1200 },
});
