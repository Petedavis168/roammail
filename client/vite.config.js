import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  plugins: [react()],
  // /assets belongs to the public website (logos); the app's files go to /app-assets
  build: { assetsDir: 'app-assets' },
  server: { proxy: { '/api': 'http://localhost:3000' } },
});
