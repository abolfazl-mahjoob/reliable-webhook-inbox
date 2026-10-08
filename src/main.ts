import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module';

async function main(): Promise<void> {
  // RawBody is essential: signing a reserialized JSON body is incorrect.
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    rawBody: true,
    bodyParser: false,
  });
  app.useBodyParser('json', { limit: '256kb' });
  app.enableShutdownHooks();
  await app.listen(Number(process.env.PORT || '3000'), '0.0.0.0');
}
main().catch((error: unknown) => {
  console.error('server-start-failed', error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
});
