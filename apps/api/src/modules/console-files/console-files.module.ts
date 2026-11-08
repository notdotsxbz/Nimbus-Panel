import { Module } from "@nestjs/common";
import { AuditModule } from "../audit/audit.module";
import { NodesModule } from "../nodes/nodes.module";
import { ServicesModule } from "../services/services.module";
import { ConsoleFilesController } from "./console-files.controller";

@Module({
  imports: [NodesModule, ServicesModule, AuditModule],
  controllers: [ConsoleFilesController],
})
export class ConsoleFilesModule {}
