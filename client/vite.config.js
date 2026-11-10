import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Each build gets an id; open copies of the app compare it with /version.json and offer a reload after an update
const BUILD_ID = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;

export default defineConfig({
  plugins: [react(), {
    name: 'roammail-version',
    generateBundle() { this.emitFile({ type: 'asset', fileName: 'version.json', source: JSON.stringify({ build: BUILD_ID }) }); },
  }],
  define: { __BUILD_ID__: JSON.stringify(BUILD_ID) },
  // /assets belongs to the public website (logos); the app's files go to /app-assets
  build: { assetsDir: 'app-assets' },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
