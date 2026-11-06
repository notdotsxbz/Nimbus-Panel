import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { NodesModule } from "../nodes/nodes.module";
import { ServicesModule } from "../services/services.module";
import { Backup, BackupSchema } from "./backup.schema";
import { BackupsController } from "./backups.controller";
import { BackupsService } from "./backups.service";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Backup.name, schema: BackupSchema }]),
    NodesModule,
    ServicesModule,
    AuditModule,
  ],
  controllers: [BackupsController],
  providers: [BackupsService],
  exports: [BackupsService],
})
export class BackupsModule {}
