import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { ServicesModule } from "../services/services.module";
import { BackupsModule } from "../backups/backups.module";
import { NodesModule } from "../nodes/nodes.module";
import { SoftwareController } from "./software.controller";
import { SoftwareService } from "./software.service";
import { Software, SoftwareSchema } from "./software.schema";
import { SoftwareVersion, SoftwareVersionSchema } from "./software-version.schema";
import { SoftwareOperation, SoftwareOperationSchema } from "./software-operation.schema";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Software.name, schema: SoftwareSchema },
      { name: SoftwareVersion.name, schema: SoftwareVersionSchema },
      { name: SoftwareOperation.name, schema: SoftwareOperationSchema },
    ]),
    AuditModule,
    ServicesModule,
    BackupsModule,
    NodesModule,
  ],
  controllers: [SoftwareController],
  providers: [SoftwareService],
  exports: [SoftwareService],
})
export class SoftwareModule {}
