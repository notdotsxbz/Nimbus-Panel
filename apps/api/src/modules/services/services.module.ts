import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { NodesModule } from "../nodes/nodes.module";
import { Service, ServiceSchema } from "./service.schema";
import { User, UserSchema } from "../users/user.schema";
import { ServicesController } from "./services.controller";
import { ServicesService } from "./services.service";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Service.name, schema: ServiceSchema }, { name: User.name, schema: UserSchema }]),
    NodesModule,
    AuditModule,
  ],
  controllers: [ServicesController],
  providers: [ServicesService],
  exports: [ServicesService],
})
export class ServicesModule {}
