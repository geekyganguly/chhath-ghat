import { defineConfig } from 'vite';

export default defineConfig({
  // relative asset paths so the build works from any sub-path (GitHub Pages, itch.io, etc.)
  base: './',
  build: { chunkSizeWarningLimit: 1000 },
});
