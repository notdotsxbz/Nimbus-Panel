import { Body, Controller, Delete, Get, Headers, Post } from "@nestjs/common";
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
  connect(@Body() dto: { serviceAccountJson: string; webConfig?: { apiKey: string; authDomain: string; projectId: string; appId: string; storageBucket?: string; messagingSenderId?: string; googleClientId?: string } }, @CurrentUser() user: AuthUser) {
    return this.integrations.connectFirebase(dto.serviceAccountJson, user.id, dto.webConfig);
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
  @Roles("owner", "admin")
  beginGoogleDriveConnect(@Body() dto: { clientId: string; clientSecret: string }, @CurrentUser() user: AuthUser, @Headers("origin") origin?: string) {
    return this.integrations.beginGoogleDriveConnect(dto.clientId, dto.clientSecret, user.id, origin);
  }

  @Post("google-drive/exchange")
  @Roles("owner", "admin")
  exchangeGoogleDriveCode(@Body() dto: { code: string; state: string }, @CurrentUser() user: AuthUser) {
    return this.integrations.exchangeGoogleDriveCode(dto.code, dto.state, user.id);
  }

  @Get("customer/google-drive")
  @Roles("customer")
  customerGoogleDriveStatus(@CurrentUser() user: AuthUser) {
    return this.integrations.googleDriveStatus("customer", user.id);
  }

  @Post("customer/google-drive/connect")
  @Roles("customer")
  beginCustomerGoogleDriveConnect(@CurrentUser() user: AuthUser, @Headers("origin") origin?: string) {
    return this.integrations.beginCustomerGoogleDriveConnect(user.id, origin);
  }

  @Post("customer/google-drive/exchange")
  @Roles("customer")
  exchangeCustomerGoogleDriveCode(@Body() dto: { code: string; state: string }, @CurrentUser() user: AuthUser) {
    return this.integrations.exchangeGoogleDriveCode(dto.code, dto.state, user.id);
  }

  @Delete("customer/google-drive")
  @Roles("customer")
  disconnectCustomerGoogleDrive(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectGoogleDrive(user.id, "customer", user.id);
  }

  @Delete("google-drive")
  @Roles("owner", "admin")
  disconnectGoogleDrive(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectGoogleDrive(user.id);
  }

  @Delete("firebase")
  @Roles("owner")
  disconnect(@CurrentUser() user: AuthUser) {
    return this.integrations.disconnectFirebase(user.id);
  }
}
