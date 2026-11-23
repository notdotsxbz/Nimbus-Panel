import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { NodesModule } from "../nodes/nodes.module";
import { ServicesModule } from "../services/services.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { NotificationsModule } from "../notifications/notifications.module";
import { Backup, BackupSchema, BackupSchedule, BackupScheduleSchema, BackupJob, BackupJobSchema } from "./backup.schema";
import { BackupsController } from "./backups.controller";
import { BackupsService } from "./backups.service";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Backup.name, schema: BackupSchema }, { name: BackupSchedule.name, schema: BackupScheduleSchema }, { name: BackupJob.name, schema: BackupJobSchema }]),
    NodesModule,
    ServicesModule,
    IntegrationsModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule {}
