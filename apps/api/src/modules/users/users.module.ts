import { Module } from "@nestjs/common";
import { MongooseModule } from "@nestjs/mongoose";
import { AuditModule } from "../audit/audit.module";
import { User, UserSchema } from "./user.schema";
import { UsersController } from "./users.controller";
import { UsersService } from "./users.service";

@Module({
  imports: [
    MongooseModule.forFeature([{ name: User.name, schema: UserSchema }]),
    AuditModule,
  ],
  controllers: [UsersController],
  providers: [UsersService],
  exports: [UsersService],
})
export class UsersModule {}
