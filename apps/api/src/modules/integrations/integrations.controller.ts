import { Body, Controller, Delete, Get, Post } from "@nestjs/common";
import { Roles, CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { IntegrationsService } from "./integrations.service";

@Controller("integrations")
@Roles("owner", "admin")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get("firebase")
  status() {
    return this.integrations.firebaseStatus();
  }

  @Post("firebase")
  connect(@Body() dto: { serviceAccountJson: string }, @CurrentUser() user: AuthUser) {
    return this.integrations.connectFirebase(dto.serviceAccountJson, user.id);
  }

  @Delete("firebase")
  disconnect(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectFirebase(user.id);
  }
}
