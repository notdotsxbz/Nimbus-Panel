import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { Allocation, AllocationSchema } from "./allocation.schema";
import { AllocationsController } from "./allocations.controller";
import { AllocationsService } from "./allocations.service";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Allocation.name, schema: AllocationSchema }]),
    AuditModule,
  ],
  controllers: [AllocationsController],
  providers: [AllocationsService],
  exports: [AllocationsService],
})
export class AllocationsModule {}
