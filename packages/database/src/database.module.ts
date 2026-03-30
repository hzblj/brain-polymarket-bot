import { existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { type DynamicModule, Global, Module } from '@nestjs/common';
import { createDb } from './client';

export const DATABASE_CLIENT = 'DATABASE_CLIENT';

@Global()
@Module({})
export class DatabaseModule {
  static forRoot(dbPath?: string): DynamicModule {
    const resolvedPath = dbPath ?? process.env.DATABASE_PATH ?? './data/brain.sqlite';

    return {
      module: DatabaseModule,
      global: true,
      providers: [
        {
          provide: DATABASE_CLIENT,
          useFactory: () => {
            // Ensure the directory exists
            const dir = dirname(resolvedPath);
            if (!existsSync(dir)) {
              mkdirSync(dir, { recursive: true });
            }

            const db = createDb(resolvedPath);
            return db;
          },
        },
      ],
      exports: [DATABASE_CLIENT],
    };
  }
}
