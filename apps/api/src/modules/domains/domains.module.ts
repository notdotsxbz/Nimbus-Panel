import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { Domain, DomainSchema } from "./domain.schema";
import { DomainsController } from "./domains.controller";
import { DomainsService } from "./domains.service";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: Domain.name, schema: DomainSchema }]),
    AuditModule,
  ],
  controllers: [DomainsController],
  providers: [DomainsService],
  exports: [DomainsService],
})
export class DomainsModule {}
