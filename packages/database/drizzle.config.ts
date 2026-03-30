import { defineConfig } from 'drizzle-kit';

// biome-ignore lint/style/noDefaultExport: required by drizzle-kit
export default defineConfig({
  schema: './src/schema.ts',
  out: './drizzle',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_PATH ?? './data/brain.sqlite',
  },
  verbose: true,
  strict: true,
});
