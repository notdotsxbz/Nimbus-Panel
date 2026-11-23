import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { NodesModule } from "../nodes/nodes.module";
import { ServicesModule } from "../services/services.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { Backup, BackupSchema } from "./backup.schema";
import { User, UserSchema } from "../users/user.schema";
import { PanelBackup, PanelBackupSchema } from "./panel-backup.schema";
import { BackupSchedule, BackupScheduleSchema } from "./backup-schedule.schema";
import { PanelBackupSchedule, PanelBackupScheduleSchema } from "./panel-backup-schedule.schema";
import { BackupsController } from "./backups.controller";
import { BackupsService } from "./backups.service";
import { PanelBackupsService } from "./panel-backups.service";
import { BackupSchedulerService } from "./backup-scheduler.service";
import { NotificationsModule } from "../notifications/notifications.module";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Backup.name, schema: BackupSchema },
      { name: User.name, schema: UserSchema },
      { name: PanelBackup.name, schema: PanelBackupSchema },
      { name: BackupSchedule.name, schema: BackupScheduleSchema },
      { name: PanelBackupSchedule.name, schema: PanelBackupScheduleSchema },
    ]),
    NodesModule,
    ServicesModule,
    IntegrationsModule,
    AuditModule,
    NotificationsModule,
  ],
  controllers: [BackupsController],
  providers: [BackupsService, PanelBackupsService, BackupSchedulerService],
  exports: [BackupsService, PanelBackupsService, BackupSchedulerService],
})
export class BackupsModule {}
