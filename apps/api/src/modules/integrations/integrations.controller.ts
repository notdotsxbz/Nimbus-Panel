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
  @Roles("owner")
  connect(@Body() dto: { serviceAccountJson: string; webConfig?: { apiKey: string; authDomain: string; projectId: string; appId: string; storageBucket?: string; messagingSenderId?: string } }, @CurrentUser() user: AuthUser) {
    return this.integrations.connectFirebase(dto.serviceAccountJson, user.id, dto.webConfig);
  }

  @Post("firebase/users")
  @Roles("owner")
  createFirebaseUser(@Body() dto: { email: string; password: string; displayName?: string }) {
    return this.integrations.createFirebaseAuthUser(dto.email, dto.password, dto.displayName);
  }

  @Get("cloudflare")
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

  @Get("google-drive")
  googleDriveStatus() {
    return this.integrations.googleDriveStatus();
  }

  @Post("google-drive/connect")
  @Roles("owner")
  beginGoogleDriveConnect(@Body() dto: { clientId: string; clientSecret: string }, @CurrentUser() user: AuthUser) {
    return this.integrations.beginGoogleDriveConnect(dto.clientId, dto.clientSecret, user.id);
  }

  @Post("google-drive/exchange")
  @Roles("owner")
  exchangeGoogleDriveCode(@Body() dto: { code: string; state: string }) {
    return this.integrations.exchangeGoogleDriveCode(dto.code, dto.state);
  }

  @Delete("google-drive")
  @Roles("owner")
  disconnectGoogleDrive(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectGoogleDrive(user.id);
  }

  @Delete("firebase")
  @Roles("owner")
  disconnect(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectFirebase(user.id);
  }
}
