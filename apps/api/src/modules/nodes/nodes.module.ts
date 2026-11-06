import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { Node, NodeSchema } from "./node.schema";
import { Service, ServiceSchema } from "../services/service.schema";
import { NodesController } from "./nodes.controller";
import { NodesService } from "./nodes.service";

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Node.name, schema: NodeSchema },
      { name: Service.name, schema: ServiceSchema },
    ]),
    AuditModule,
  ],
  controllers: [NodesController],
  providers: [NodesService],
  exports: [NodesService],
})
export class NodesModule {}
