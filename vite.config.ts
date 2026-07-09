import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

interface PackageJson { version?: string }

const root = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as PackageJson;

/** Stamp a unique BUILD_ID into dist/sw.js so browsers detect SW updates. */
function stampServiceWorker(): Plugin {
  return {
    name: 'stamp-service-worker',
    apply: 'build',
    closeBundle() {
      const swPath = join(root, 'dist', 'sw.js');
      if (!existsSync(swPath)) return;
      const buildId = `${pkg.version || '0'}-${Date.now().toString(36)}`;
      let src = readFileSync(swPath, 'utf8');
      // Replace the first BUILD_ID assignment (dev default).
      src = src.replace(
        /const BUILD_ID = ['"][^'"]*['"]/,
        `const BUILD_ID = ${JSON.stringify(buildId)}`,
      );
      writeFileSync(swPath, src, 'utf8');
      // Also write a tiny build-id asset for non-SW poll fallback.
      writeFileSync(join(root, 'dist', 'build-id.txt'), buildId + '\n', 'utf8');
    },
  };
}

// React is mounted only inside the Live agent flow page (src/views/system/flow.jsx).
// The rest of the dashboard stays vanilla; the plugin just enables JSX/TSX transform
// and pulls in the react-refresh runtime in dev.
export default defineConfig({
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
  },
  plugins: [
    react({
      include: /\.(jsx|tsx)$/,
    }),
    stampServiceWorker(),
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
