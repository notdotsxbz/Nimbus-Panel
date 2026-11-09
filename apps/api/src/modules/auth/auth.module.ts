import { Module } from "@nestjs/common";
import { JwtModule } from "@nestjs/jwt";
import { env } from "../../config/env";
import { FirebaseAdminService } from "../../firebase/firebase-admin.service";
import { AuditModule } from "../audit/audit.module";
import { UsersModule } from "../users/users.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { AuthController } from "./auth.controller";

@Module({
  imports: [
    UsersModule,
    IntegrationsModule,
    AuditModule,
    JwtModule.register({ global: true, secret: env.jwtSecret }),
  ],
  controllers: [AuthController],
  providers: [FirebaseAdminService],
})
export class AuthModule {}
