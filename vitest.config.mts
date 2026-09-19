import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const source = (name: string) =>
  fileURLToPath(new URL(`./packages/${name}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: {
      '@auto-product-video-generator/ai': source('ai'),
      '@auto-product-video-generator/core': source('core'),
      '@auto-product-video-generator/playwright': source('playwright'),
      '@auto-product-video-generator/recorder': source('recorder'),
      '@auto-product-video-generator/renderer': source('renderer'),
      '@auto-product-video-generator/source': source('source'),
      '@auto-product-video-generator/voicevox': source('voicevox'),
    },
  },
});
