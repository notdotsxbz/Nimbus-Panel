import { Body, Controller, Delete, Get, Headers, Post } from "@nestjs/common";
import { Roles, CurrentUser, type AuthUser } from "../../common/auth.decorators";
import { IntegrationsService } from "./integrations.service";

@Controller("integrations")
export class IntegrationsController {
  constructor(private readonly integrations: IntegrationsService) {}

  @Get("firebase")
  @Roles("owner", "admin")
  status() {
    return this.integrations.firebaseStatus();
  }

  @Post("firebase")
  @Roles("owner")
  connect(@Body() dto: { serviceAccountJson: string; webConfig?: { apiKey: string; authDomain: string; projectId: string; appId: string; storageBucket?: string; messagingSenderId?: string; googleClientId?: string } }, @CurrentUser() user: AuthUser) {
    return this.integrations.connectFirebase(dto.serviceAccountJson, user.id, dto.webConfig);
  }

  @Get("cloudflare")
  @Roles("owner", "admin")
  cloudflareStatus() {
    return this.integrations.cloudflareStatus();
  }

  @Post("cloudflare")
  @Roles("owner")
  connectCloudflare(@Body() dto: { apiToken: string; zoneId: string }, @CurrentUser() user: AuthUser) {
    return this.integrations.connectCloudflare(dto.apiToken, dto.zoneId, user.id);
  }

  @Delete("cloudflare")
  @Roles("owner")
  disconnectCloudflare(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectCloudflare(user.id);
  }

  // Google Drive is intentionally available to customers as well as staff.
  // The service scopes every connection and OAuth state to the signed-in user.
  @Get("google-drive")
  googleDriveStatus(@CurrentUser() user: AuthUser) {
    return this.integrations.googleDriveStatus(user);
  }

  @Post("google-drive/connect")
  beginGoogleDriveConnect(@Body() dto: { clientId?: string; clientSecret?: string }, @CurrentUser() user: AuthUser, @Headers("origin") origin?: string) {
    return this.integrations.beginGoogleDriveConnect(dto.clientId, dto.clientSecret, user, origin);
  }

  @Post("google-drive/exchange")
  exchangeGoogleDriveCode(@Body() dto: { code: string; state: string }, @CurrentUser() user: AuthUser) {
    return this.integrations.exchangeGoogleDriveCode(dto.code, dto.state, user);
  }

  @Delete("google-drive")
  disconnectGoogleDrive(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectGoogleDrive(user);
  }

  @Delete("firebase")
  @Roles("owner")
  disconnect(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectFirebase(user.id);
  }
}
