import type { ModuleMetadata } from '@nestjs/common';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { Test, type TestingModule } from '@nestjs/testing';

export interface TestAppResult {
  app: NestFastifyApplication;
  module: TestingModule;
  close: () => Promise<void>;
}

/**
 * Creates a NestJS test application with Fastify adapter.
 * Automatically initializes the app and provides a cleanup function.
 */
export async function createTestApp(metadata: ModuleMetadata): Promise<TestAppResult> {
  const moduleBuilder = Test.createTestingModule(metadata);
  const module = await moduleBuilder.compile();

  const app = module.createNestApplication<NestFastifyApplication>(new FastifyAdapter());

  await app.init();
  await app.getHttpAdapter().getInstance().ready();

  return {
    app,
    module,
    close: async () => {
      await app.close();
    },
  };
}
