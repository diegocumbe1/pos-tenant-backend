import { ValidationPipe } from '@nestjs/common';
import { HttpAdapterHost, NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import * as bodyParser from 'body-parser';
import { AppModule } from './app.module';
import { PrismaExceptionFilter } from './prisma/prisma-exception.filter';

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.setGlobalPrefix('api/v1');

  // CORS: en prod se restringe vía CORS_ORIGINS (lista separada por comas,
  // p.ej. "https://uselynko.com"). Sin la env → refleja cualquier origen (dev).
  const corsOrigins = process.env.CORS_ORIGINS?.split(',')
    .map((o) => o.trim())
    .filter(Boolean);
  app.enableCors({
    origin: corsOrigins && corsOrigins.length > 0 ? corsOrigins : true,
    credentials: true,
    maxAge: Number(process.env.CORS_MAX_AGE_SECONDS ?? 86400),
    exposedHeaders: [
      'Server-Timing',
      'X-Request-Id',
      'X-Request-Duration-Ms',
      'X-Handler-Duration-Ms',
      'X-Prisma-Query-Count',
      'X-Prisma-Db-Ms',
      'X-Prisma-Slowest-Ms',
    ],
  });

  // Read body parser limit from env (e.g. BODY_PARSER_LIMIT='10mb'), default to 10mb
  const bodyParserLimit = process.env.BODY_PARSER_LIMIT ?? '10mb';
  app.use(bodyParser.json({ limit: bodyParserLimit }));
  app.use(bodyParser.urlencoded({ limit: bodyParserLimit, extended: true }));

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
      transformOptions: {
        enableImplicitConversion: true,
      },
    }),
  );

  const httpAdapterHost = app.get(HttpAdapterHost);
  app.useGlobalFilters(new PrismaExceptionFilter(httpAdapterHost));

  const swaggerConfig = new DocumentBuilder()
    .setTitle('POS System Backend')
    .setDescription('API documentation for POS System Backend')
    .setVersion('1.0.0')
    .addBearerAuth()
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Tenant-Id' }, 'X-Tenant-Id')
    .addApiKey({ type: 'apiKey', in: 'header', name: 'X-Branch-Id' }, 'X-Branch-Id')
    .build();

  const swaggerDocument = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup('docs', app, swaggerDocument);

  const port = Number(process.env.PORT ?? 3001);

  await app.listen(port, '0.0.0.0');

  console.log(`Server running on http://localhost:${port}`);
  console.log(`Swagger available on http://localhost:${port}/docs`);
}

void bootstrap();
