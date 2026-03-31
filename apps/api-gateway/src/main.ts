import 'dotenv/config';
import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { FastifyAdapter, type NestFastifyApplication } from '@nestjs/platform-fastify';
import { AppModule } from './app.module';

const PORT = 3000;

async function bootstrap() {
  const app = await NestFactory.create<NestFastifyApplication>(AppModule, new FastifyAdapter());

  app.enableShutdownHooks();

  // Manual CORS via Fastify hook — enableCors() doesn't work reliably with Fastify adapter
  const fastify = app.getHttpAdapter().getInstance();
  fastify.addHook('onRequest', async (request: any, reply: any) => {
    const origin = request.headers.origin;
    if (origin) {
      reply.header('access-control-allow-origin', origin);
      reply.header('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
      reply.header('access-control-allow-headers', 'content-type,authorization');
    }
    if (request.method === 'OPTIONS') {
      reply.status(204).send();
    }
  });

  await app.listen(PORT, '0.0.0.0');
}

bootstrap();
