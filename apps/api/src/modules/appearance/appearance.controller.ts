import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from "@nestjs/common";
import { ANIMATION_PRESETS } from "@nimbus/shared";
import { CurrentUser, Roles, type AuthUser } from "../../common/auth.decorators";
import { Public } from "../../common/public.decorator";
import { AppearanceService } from "./appearance.service";

@Controller("appearance")
export class AppearanceController {
  constructor(private readonly appearance: AppearanceService) {}

  // ── Public / customer-reachable ─────────────────────────────────

  /** Customer-safe global settings (no admin-only fields). */
  @Public()
  @Get("public-settings")
  publicSettings() {
    return this.appearance.getPublicSettings();
  }

  @Get("themes")
  themes(@CurrentUser() user: AuthUser) {
    return this.appearance.listThemes(["owner", "admin", "staff"].includes(user.role));
  }

  @Get("presets")
  presets() {
    // Static animation preset definitions served for the UI.
    return ANIMATION_PRESETS;
  }

  @Get("me")
  me(@CurrentUser() user: AuthUser) {
    return this.appearance.resolveForUser(user.id);
  }

  @Put("me")
  updateMe(@CurrentUser() user: AuthUser, @Body() dto: Record<string, unknown>) {
    return this.appearance.updateUserPreferences(user.id, dto);
  }

  @Post("me/reset")
  resetMe(@CurrentUser() user: AuthUser) {
    return this.appearance.resetUserPreferences(user.id);
  }

  @Get("stats")
  @Roles("owner", "admin", "staff")
  stats() {
    return this.appearance.stats();
  }

  // ── Admin-only theme management ─────────────────────────────────

  @Post("themes")
  @Roles("owner", "admin")
  create(@CurrentUser() actor: AuthUser, @Body() dto: Record<string, unknown>) {
    return this.appearance.createTheme(dto as never, actor.id);
  }

  @Patch("themes/:key")
  @Roles("owner", "admin")
  update(
    @Param("key") key: string,
    @CurrentUser() actor: AuthUser,
    @Body() dto: Record<string, unknown>,
  ) {
    return this.appearance.updateTheme(key, dto, actor.id);
  }

  @Post("themes/:key/duplicate")
  @Roles("owner", "admin")
  duplicate(@Param("key") key: string, @CurrentUser() actor: AuthUser) {
    return this.appearance.duplicateTheme(key, actor.id);
  }

  @Delete("themes/:key")
  @Roles("owner", "admin")
  remove(@Param("key") key: string, @CurrentUser() actor: AuthUser) {
    return this.appearance.deleteTheme(key, actor.id);
  }

  @Post("themes/:key/publish")
  @Roles("owner", "admin")
  publish(@Param("key") key: string, @CurrentUser() actor: AuthUser, @Body() dto: { published?: boolean }) {
    return this.appearance.publishTheme(key, dto.published !== false, actor.id);
  }

  @Post("themes/:key/default")
  @Roles("owner", "admin")
  setDefault(@Param("key") key: string, @CurrentUser() actor: AuthUser) {
    return this.appearance.setDefaultTheme(key, actor.id);
  }

  @Post("themes/import")
  @Roles("owner", "admin")
  import(@CurrentUser() actor: AuthUser, @Body() dto: Record<string, unknown>) {
    return this.appearance.importTheme(dto.payload ?? dto, actor.id);
  }

  @Get("themes/:key/export")
  @Roles("owner", "admin")
  export(@Param("key") key: string, @CurrentUser() actor: AuthUser) {
    return this.appearance.exportTheme(key, actor.id);
  }

  // ── Admin-only global settings ──────────────────────────────────

  @Get("settings")
  @Roles("owner", "admin", "staff")
  settings() {
    return this.appearance.getSettings();
  }

  @Patch("settings")
  @Roles("owner", "admin")
  updateSettings(@CurrentUser() actor: AuthUser, @Body() dto: Record<string, unknown>) {
    return this.appearance.updateSettings(dto, actor.id);
  }
}
