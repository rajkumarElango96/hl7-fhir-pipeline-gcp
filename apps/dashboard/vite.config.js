import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const OPS = `http://127.0.0.1:${process.env.OPS_API_PORT ?? 4000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': OPS,
      '/ws': { target: OPS.replace('http', 'ws'), ws: true },
    },
  },
});
