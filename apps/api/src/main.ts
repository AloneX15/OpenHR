import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { NestExpressApplication } from '@nestjs/platform-express';
import cookieParser from 'cookie-parser';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module';
import { ErrorsFilter } from './common/errors.filter';
import { config } from './config';

export function configureApp(app: NestExpressApplication) {
  app.setGlobalPrefix('api');
  app.use(cookieParser());
  app.set('trust proxy', 'loopback, linklocal, uniquelocal');
  app.disable('x-powered-by');
  // Defensa CSRF adicional a SameSite=Lax: las peticiones que modifican datos deben venir
  // de nuestra propia web (o no traer Origin, como curl o los tests).
  const allowed = new URL(config.publicUrl).origin;
  app.use((req: Request, res: Response, next: NextFunction) => {
    const origin = req.headers.origin;
    if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== allowed) {
      res.status(403).json({ message: 'Origen no permitido' });
      return;
    }
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
    res.setHeader('Referrer-Policy', 'same-origin');
    next();
  });
  app.useGlobalFilters(new ErrorsFilter());
  app.enableShutdownHooks();
  return app;
}

async function bootstrap() {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, { bodyParser: true });
  configureApp(app);
  await app.listen(config.port, '0.0.0.0');
  console.log(`OpenHR API escuchando en el puerto ${config.port}`);
}

if (require.main === module) void bootstrap();
