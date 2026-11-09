import { Module } from "@nestjs/common";
import { ConfigModule } from "@nestjs/config";
import { MongooseModule } from "@nestjs/mongoose";
import { ThrottlerModule, ThrottlerGuard } from "@nestjs/throttler";
import { APP_GUARD } from "@nestjs/core";
import { env } from "./config/env";
import { JwtAuthGuard, RolesGuard } from "./common/guards";
import { AuthModule } from "./modules/auth/auth.module";
import { UsersModule } from "./modules/users/users.module";
import { NodesModule } from "./modules/nodes/nodes.module";
import { ServicesModule } from "./modules/services/services.module";
import { AllocationsModule } from "./modules/allocations/allocations.module";
import { DomainsModule } from "./modules/domains/domains.module";
import { BackupsModule } from "./modules/backups/backups.module";
import { AuditModule } from "./modules/audit/audit.module";
import { AppearanceModule } from "./modules/appearance/appearance.module";
import { TicketsModule } from "./modules/tickets/tickets.module";
import { MigrationsModule } from "./modules/migrations/migrations.module";
import { NotificationsModule } from "./modules/notifications/notifications.module";
import { ConsoleFilesModule } from "./modules/console-files/console-files.module";
import { IntegrationsModule } from "./modules/integrations/integrations.module";

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    MongooseModule.forRoot(env.mongoUri),
    ThrottlerModule.forRoot([
      {
        ttl: parseInt(process.env.RATE_LIMIT_WINDOW_MS ?? "60000", 10),
        limit: parseInt(process.env.RATE_LIMIT_MAX_REQUESTS ?? "100", 10),
      },
    ]),
    AuthModule,
    UsersModule,
    NodesModule,
    ServicesModule,
    AllocationsModule,
    DomainsModule,
    BackupsModule,
    AuditModule,
    AppearanceModule,
    TicketsModule,
    ConsoleFilesModule,
    MigrationsModule,
    NotificationsModule,
    IntegrationsModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: ThrottlerGuard },
    { provide: APP_GUARD, useClass: JwtAuthGuard },
    { provide: APP_GUARD, useClass: RolesGuard },
  ],
})
export class AppModule {}
