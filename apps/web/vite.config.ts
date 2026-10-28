import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

const target = process.env.API_URL || 'http://localhost:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': target,
      '/s/': target,
      '/_site': target,
      '/files': target,
      '/healthz': target,
      '/collab': { target: target.replace(/^http/, 'ws'), ws: true },
    },
  },
  build: {
    chunkSizeWarningLimit: 4000,
    rollupOptions: {
      output: {
        manualChunks: {
          editor: ['@tiptap/react', '@tiptap/starter-kit', 'yjs', 'y-websocket', 'lowlight'],
          charts: ['recharts'],
        },
      },
    },
  },
});
