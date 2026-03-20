import { Test, TestingModule } from '@nestjs/testing';
import { FastifyAdapter, NestFastifyApplication } from '@nestjs/platform-fastify';
import type { ModuleMetadata } from '@nestjs/common';

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

  const app = module.createNestApplication<NestFastifyApplication>(
    new FastifyAdapter(),
  );

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
