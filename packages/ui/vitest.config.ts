// REQ-UI-001 — vitest configuration for the Obsidian Pro design system (jsdom so React components can mount).
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
