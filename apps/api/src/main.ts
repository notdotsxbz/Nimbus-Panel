import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe, Logger } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import type { NextFunction, Request, Response } from "express";
import { AppModule } from "./app.module";
import { env, isProduction } from "./config/env";
import { JWT_COOKIE } from "./common/constants";

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.useLogger(new Logger("Nimbus"));
  app.setGlobalPrefix("api/v1");
  app.enableCors({
    origin: env.webUrl,
    credentials: true,
  });
  app.useWebSocketAdapter(new WsAdapter(app));
  app.useGlobalPipes(
    new ValidationPipe({ whitelist: true, transform: true, forbidNonWhitelisted: true }),
  );

  if (isProduction) {
    // Secure headers (behind nginx/caddy TLS termination)
    app.use((_req: Request, res: Response, next: NextFunction) => {
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("X-Frame-Options", "DENY");
      res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
      res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
      next();
    });
  }

  await app.listen(env.port);
  new Logger("Nimbus").log(`API listening on :${env.port} (prefix /api/v1, cookie ${JWT_COOKIE})`);
}

void bootstrap();
