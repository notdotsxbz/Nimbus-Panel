import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { IntegrationSetting, IntegrationSettingSchema } from "./integration.schema";
import { IntegrationsController } from "./integrations.controller";
import { IntegrationsService } from "./integrations.service";

@Module({
  imports: [MongooseModule.forFeature([{ name: IntegrationSetting.name, schema: IntegrationSettingSchema }])],
  controllers: [IntegrationsController],
  providers: [IntegrationsService],
  exports: [IntegrationsService],
})
export class IntegrationsModule {}
