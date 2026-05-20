import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// React is mounted only inside the Live agent flow page (src/views/system/flow.jsx).
// The rest of the dashboard stays vanilla; the plugin just enables JSX transform
// for .jsx files and pulls in the react-refresh runtime in dev.
export default defineConfig({
  plugins: [
    react({
      include: /\.jsx$/,
    }),
  ],
  server: {
    port: 7911,
    strictPort: true,
    proxy: {
      '/api': 'http://127.0.0.1:7910',
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
