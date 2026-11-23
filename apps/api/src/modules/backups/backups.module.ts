import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { NodesModule } from "../nodes/nodes.module";
import { ServicesModule } from "../services/services.module";
import { IntegrationsModule } from "../integrations/integrations.module";
import { Backup, BackupSchema } from "./backup.schema";
import { User, UserSchema } from "../users/user.schema";
import { PanelBackup, PanelBackupSchema } from "./panel-backup.schema";
import { BackupsController } from "./backups.controller";
import { BackupsService } from "./backups.service";
import { PanelBackupsService } from "./panel-backups.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Backup.name, schema: BackupSchema },
      { name: User.name, schema: UserSchema },
      { name: PanelBackup.name, schema: PanelBackupSchema },
    ]),
    NodesModule,
    ServicesModule,
    IntegrationsModule,
    AuditModule,
  ],
  controllers: [BackupsController],
  providers: [BackupsService, PanelBackupsService],
  exports: [BackupsService, PanelBackupsService],
})
export class BackupsModule {}
