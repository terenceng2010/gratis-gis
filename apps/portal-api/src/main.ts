// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    cors: true,
  });
  // Don't advertise the Express framework over the wire.  The
  // default `x-powered-by: Express` header is informational only,
  // but it hands an attacker exact version targeting.
  app.disable('x-powered-by');
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api', { exclude: ['/health', '/docs'] });

  // Swagger UI is useful in dev and CI but exposes the full API
  // surface (endpoints, schemas, request shapes) to anyone who
  // hits /docs in production.  Gate behind ENABLE_SWAGGER so prod
  // ships without it and local dev opt-ins via NODE_ENV=development
  // (the dev compose sets this implicitly).
  const enableSwagger =
    process.env.ENABLE_SWAGGER === '1' ||
    process.env.NODE_ENV !== 'production';
  if (enableSwagger) {
    const swagger = new DocumentBuilder()
      .setTitle('GratisGIS Portal API')
      .setDescription('Users, groups, items, sharing, and feature services.')
      .setVersion('0.0.0')
      .addBearerAuth()
      .build();
    SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));
  }

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`portal-api listening on http://localhost:${port}`);
}

bootstrap();
