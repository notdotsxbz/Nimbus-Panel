import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import {
  AppearanceSettings,
  AppearanceSettingsSchema,
  Theme,
  ThemeSchema,
  UserAppearance,
  UserAppearanceSchema,
} from "./appearance.schema";
import { AppearanceController } from "./appearance.controller";
import { AppearanceService } from "./appearance.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Theme.name, schema: ThemeSchema },
      { name: AppearanceSettings.name, schema: AppearanceSettingsSchema },
      { name: UserAppearance.name, schema: UserAppearanceSchema },
    ]),
    AuditModule,
  ],
  controllers: [AppearanceController],
  providers: [AppearanceService],
  exports: [AppearanceService],
})
export class AppearanceModule {}
