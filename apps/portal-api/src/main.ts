// SPDX-License-Identifier: AGPL-3.0-or-later
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module.js';

async function bootstrap() {
  const app = await NestFactory.create(AppModule, { cors: true });
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, forbidNonWhitelisted: true, transform: true }),
  );
  app.setGlobalPrefix('api', { exclude: ['/health', '/docs'] });

  const swagger = new DocumentBuilder()
    .setTitle('GratisGIS Portal API')
    .setDescription('Users, groups, items, sharing, and feature services.')
    .setVersion('0.0.0')
    .addBearerAuth()
    .build();
  SwaggerModule.setup('docs', app, SwaggerModule.createDocument(app, swagger));

  const port = Number(process.env.PORT ?? 4000);
  await app.listen(port);
  // eslint-disable-next-line no-console
  console.log(`portal-api listening on http://localhost:${port}`);
}

bootstrap();
