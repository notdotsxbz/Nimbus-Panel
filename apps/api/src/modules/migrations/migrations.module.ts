import { Module } from "@nestjs/common";

import { MigrationsService } from "./migrations.service";

@Module({
  providers: [MigrationsService],
  exports: [MigrationsService],
})
export class MigrationsModule {}
