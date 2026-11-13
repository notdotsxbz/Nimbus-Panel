import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  OnModuleInit,
} from "@nestjs/common";
import { InjectModel } from "@nestjs/mongoose";
import { Model, Types } from "mongoose";
import {
  ANIMATION_PRESET_IDS,
  BUILT_IN_THEMES,
  LIGHT_DARK_PAIRS,
  validateThemeColors,
  type ThemeColors,
} from "@nimbus/shared";
import { AuditService } from "../audit/audit.service";
import {
  AppearanceSettings,
  AppearanceSettingsDocument,
  Theme,
  ThemeDocument,
  UserAppearance,
  UserAppearanceDocument,
} from "./appearance.schema";

const MAX_THEME_NAME = 48;
const MAX_DESCRIPTION = 280;
const MAX_IMPORT_BYTES = 16 * 1024; // imported JSON payloads are strictly bounded

const slug = (name: string) =>
  name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "theme";

@Injectable()
export class AppearanceService implements OnModuleInit {
  constructor(
    @InjectModel(Theme.name) private readonly themes: Model<ThemeDocument>,
    @InjectModel(AppearanceSettings.name) private readonly settingsModel: Model<AppearanceSettingsDocument>,
    @InjectModel(UserAppearance.name) private readonly prefs: Model<UserAppearanceDocument>,
    private readonly audit: AuditService,
  ) {}

  /** Seed the 10 built-in themes + the global settings doc (idempotent). */
  async onModuleInit(): Promise<void> {
    for (const def of BUILT_IN_THEMES) {
      await this.themes.updateOne(
        { key: def.id },
        {
          $setOnInsert: {
            key: def.id,
            name: def.name,
            description: def.description,
            colors: def.colors,
            mode: def.mode,
            isBuiltIn: true,
            isPublished: true,
          },
        },
        { upsert: true },
      );
    }
    const defaultKey = BUILT_IN_THEMES[0]!.id;
    await this.settingsModel.updateOne(
      { settingsId: "global" },
      { $setOnInsert: { settingsId: "global", defaultThemeKey: defaultKey, defaultAnimationPreset: "smooth" } },
      { upsert: true },
    );
  }

  // ── Themes ────────────────────────────────────────────────────────

  /** Published themes (customers) or all themes (staff). */
  async listThemes(isStaff: boolean) {
    const filter = isStaff ? {} : { isPublished: true };
    return this.themes.find(filter).sort({ isBuiltIn: -1, name: 1 });
  }

  async getThemeByKey(key: string): Promise<ThemeDocument> {
    const theme = await this.themes.findOne({ key });
    if (!theme) throw new NotFoundException("Theme not found");
    return theme;
  }

  private validateName(name: unknown): string {
    if (typeof name !== "string" || name.trim().length < 2 || name.trim().length > MAX_THEME_NAME) {
      throw new BadRequestException(`Theme name must be 2–${MAX_THEME_NAME} characters`);
    }
    return name.trim();
  }

  private validateColors(colors: unknown): ThemeColors {
    const result = validateThemeColors(colors);
    if (!result.ok || !result.colors) {
      throw new BadRequestException({ message: "Invalid theme colors", errors: result.errors });
    }
    return result.colors;
  }

  async createTheme(dto: { name: string; description?: string; colors: unknown; mode?: string }, actorId: string) {
    const name = this.validateName(dto.name);
    const colors = this.validateColors(dto.colors);
    const mode = dto.mode === "light" ? "light" : "dark";
    if (typeof dto.description === "string" && dto.description.length > MAX_DESCRIPTION) {
      throw new BadRequestException(`Description too long (max ${MAX_DESCRIPTION})`);
    }
    // Unique, human-readable key with collision suffix.
    let key = `custom-${slug(name)}`;
    let n = 1;
    while (await this.themes.findOne({ key })) key = `custom-${slug(name)}-${++n}`;

    const theme = await this.themes.create({
      key, name, colors, mode,
      description: typeof dto.description === "string" ? dto.description : undefined,
      isBuiltIn: false,
      isPublished: false,
      createdBy: new Types.ObjectId(actorId),
    });
    await this.audit.log({ actorId, action: "appearance.theme.create", targetType: "theme", targetId: key, sensitive: true });
    return theme;
  }

  async updateTheme(key: string, dto: { name?: string; description?: string; colors?: unknown; mode?: string }, actorId: string) {
    const theme = await this.getThemeByKey(key);
    if (theme.isBuiltIn) throw new ForbiddenException("Built-in themes cannot be edited — duplicate it first.");
    const update: Record<string, unknown> = {};
    if (dto.name !== undefined) update.name = this.validateName(dto.name);
    if (dto.description !== undefined) {
      if (typeof dto.description !== "string" || dto.description.length > MAX_DESCRIPTION) {
        throw new BadRequestException(`Description too long (max ${MAX_DESCRIPTION})`);
      }
      update.description = dto.description;
    }
    if (dto.mode !== undefined) update.mode = dto.mode === "light" ? "light" : "dark";
    if (dto.colors !== undefined) update.colors = this.validateColors(dto.colors);
    const updated = await this.themes.findOneAndUpdate({ key }, { $set: update }, { new: true });
    await this.audit.log({ actorId, action: "appearance.theme.update", targetType: "theme", targetId: key, sensitive: true });
    return updated;
  }

  async duplicateTheme(key: string, actorId: string) {
    const source = await this.getThemeByKey(key);
    return this.createTheme(
      { name: `${source.name} (copy)`, description: source.description, colors: source.colors, mode: source.mode },
      actorId,
    );
  }

  async deleteTheme(key: string, actorId: string) {
    const theme = await this.getThemeByKey(key);
    if (theme.isBuiltIn) throw new ForbiddenException("Built-in themes cannot be deleted.");
    const settings = await this.getSettings();
    if (settings.defaultThemeKey === key) {
      throw new BadRequestException("This theme is the published default — set another default first.");
    }
    await this.themes.deleteOne({ key });
    // Users still pointing at the deleted theme fall back to the default.
    await this.prefs.updateMany({ themeKey: key }, { $unset: { themeKey: 1 } });
    await this.audit.log({ actorId, action: "appearance.theme.delete", targetType: "theme", targetId: key, sensitive: true });
    return { ok: true };
  }

  async publishTheme(key: string, published: boolean, actorId: string) {
    const theme = await this.getThemeByKey(key);
    theme.isPublished = published;
    await theme.save();
    await this.audit.log({
      actorId, action: published ? "appearance.theme.publish" : "appearance.theme.unpublish",
      targetType: "theme", targetId: key, sensitive: true,
    });
    return theme;
  }

  async setDefaultTheme(key: string, actorId: string) {
    const theme = await this.getThemeByKey(key);
    if (!theme.isPublished) throw new BadRequestException("Publish the theme before making it the default.");
    const settings = await this.getSettings();
    settings.defaultThemeKey = key;
    settings.updatedAt = new Date();
    await settings.save();
    await this.audit.log({ actorId, action: "appearance.theme.setDefault", targetType: "theme", targetId: key, sensitive: true });
    return settings;
  }

  /** Import a previously exported theme configuration (sanitised, size-bounded). */
  async importTheme(payload: unknown, actorId: string) {
    let raw: string;
    try {
      raw = typeof payload === "string" ? payload : JSON.stringify(payload);
    } catch {
      throw new BadRequestException("Invalid import payload");
    }
    if (Buffer.byteLength(raw, "utf8") > MAX_IMPORT_BYTES) {
      throw new BadRequestException(`Import payload too large (max ${MAX_IMPORT_BYTES / 1024} KB)`);
    }
    let parsed: { name?: unknown; description?: unknown; colors?: unknown; mode?: unknown };
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException("Import payload is not valid JSON");
    }
    if (typeof parsed?.name !== "string") throw new BadRequestException("Import payload missing theme name");
    return this.createTheme(
      {
        name: parsed.name,
        description: typeof parsed.description === "string" ? parsed.description : undefined,
        colors: parsed.colors,
        mode: parsed.mode === "light" ? "light" : "dark",
      },
      actorId,
    );
  }

  exportTheme(key: string, actorId: string) {
    void actorId;
    return this.getThemeByKey(key);
  }

  // ── Global settings ──────────────────────────────────────────────

  async getSettings(): Promise<AppearanceSettingsDocument> {
    const settings = await this.settingsModel.findOne({ settingsId: "global" });
    if (!settings) throw new NotFoundException("Appearance settings missing");
    return settings;
  }

  /** Customer-safe projection — only what customers may see. */
  async getPublicSettings() {
    const s = await this.getSettings();
    return {
      allowCustomerThemes: s.allowCustomerThemes,
      allowCustomerAnimations: s.allowCustomerAnimations,
      defaultThemeKey: s.defaultThemeKey,
      defaultAnimationPreset: s.defaultAnimationPreset,
      animationsEnabled: s.animationsEnabled,
      backgroundImageData: s.backgroundImageData ?? null,
    };
  }

  async updateSettings(dto: Record<string, unknown>, actorId: string) {
    const settings = await this.getSettings();
    const num = (v: unknown, min: number, max: number) =>
      typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : undefined;

    if (dto.backgroundImageData !== undefined) {
      const image = typeof dto.backgroundImageData === "string" ? dto.backgroundImageData : "";
      if (image && (image.length > 1_400_000 || !/^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+=*$/.test(image))) {
        throw new BadRequestException("Background image must be a PNG, JPEG, WebP or GIF image smaller than 1 MB");
      }
      settings.backgroundImageData = image || undefined;
    }
    if (typeof dto.allowCustomerThemes === "boolean") settings.allowCustomerThemes = dto.allowCustomerThemes;
    if (typeof dto.allowCustomerAnimations === "boolean") settings.allowCustomerAnimations = dto.allowCustomerAnimations;
    if (typeof dto.allowCustomThemes === "boolean") settings.allowCustomThemes = dto.allowCustomThemes;
    if (typeof dto.animationsEnabled === "boolean") settings.animationsEnabled = dto.animationsEnabled;
    if (dto.defaultAnimationPreset !== undefined) {
      if (typeof dto.defaultAnimationPreset !== "string" || !(ANIMATION_PRESET_IDS as string[]).includes(dto.defaultAnimationPreset)) {
        throw new BadRequestException("Unknown animation preset");
      }
      settings.defaultAnimationPreset = dto.defaultAnimationPreset;
    }
    if (dto.defaultThemeKey !== undefined) {
      const theme = await this.themes.findOne({ key: String(dto.defaultThemeKey) });
      if (!theme) throw new BadRequestException("Unknown default theme");
      settings.defaultThemeKey = theme.key;
    }
    const speed = num(dto.animationSpeed, 0.5, 1.5);
    if (speed !== undefined) settings.animationSpeed = speed;
    const intensity = num(dto.animationIntensity, 0, 1.2);
    if (intensity !== undefined) settings.animationIntensity = intensity;

    settings.updatedAt = new Date();
    await settings.save();
    await this.audit.log({ actorId, action: "appearance.settings.update", sensitive: true, detail: Object.keys(dto).join(",") });
    return settings;
  }

  // ── Per-user preferences ─────────────────────────────────────────

  async getUserPreferences(userId: string) {
    const pref = await this.prefs.findOne({ userId: new Types.ObjectId(userId) });
    return pref ?? { userId, themeKey: undefined, colorMode: "system", animationsEnabled: true, reducedMotion: false, animationPreset: undefined };
  }

  /**
   * Resolve what a user should actually render: their preference, or the
   * admin-published default when themes/animations are locked down.
   */
  async resolveForUser(userId: string) {
    const [settings, pref] = await Promise.all([this.getSettings(), this.getUserPreferences(userId)]);
    let themeKey: string | undefined = pref.themeKey;
    if (!settings.allowCustomerThemes) themeKey = undefined; // forced default
    if (themeKey) {
      const theme = await this.themes.findOne({ key: themeKey, isPublished: true });
      if (!theme) themeKey = undefined;
    }
    let animationPreset: string | undefined = pref.animationPreset;
    if (!settings.allowCustomerAnimations || !pref.animationsEnabled) animationPreset = undefined;

    const effectiveThemeKey = themeKey ?? settings.defaultThemeKey;
    const theme = await this.getThemeByKey(effectiveThemeKey);

    // Light/dark/system: pair built-ins when the requested mode differs.
    const requestedMode =
      pref.colorMode === "system" ? undefined : pref.colorMode;
    let resolvedThemeKey = theme.key;
    if (requestedMode && requestedMode !== theme.mode) {
      const pair = LIGHT_DARK_PAIRS[theme.key];
      if (pair) {
        const pairTheme = await this.themes.findOne({ key: pair, isPublished: true });
        if (pairTheme) resolvedThemeKey = pair;
      }
    }

    return {
      themeKey: resolvedThemeKey,
      colorMode: pref.colorMode,
      animationsEnabled: settings.animationsEnabled && pref.animationsEnabled,
      reducedMotion: pref.reducedMotion,
      animationPreset: animationPreset ?? settings.defaultAnimationPreset,
    };
  }

  async updateUserPreferences(
    userId: string,
    dto: { themeKey?: unknown; colorMode?: unknown; animationsEnabled?: unknown; reducedMotion?: unknown; animationPreset?: unknown },
  ) {
    const settings = await this.getSettings();
    const update: Record<string, unknown> = {};

    if (dto.themeKey !== undefined) {
      const key = String(dto.themeKey);
      const theme = await this.themes.findOne({ key });
      if (!theme) throw new BadRequestException("Unknown theme");
      if (!settings.allowCustomerThemes) {
        throw new ForbiddenException("Theme selection is disabled by your administrator");
      }
      if (!theme.isBuiltIn && !theme.isPublished) {
        throw new ForbiddenException("That theme is not published");
      }
      update.themeKey = key;
    }
    if (dto.colorMode !== undefined) {
      if (dto.colorMode !== "light" && dto.colorMode !== "dark" && dto.colorMode !== "system") {
        throw new BadRequestException("colorMode must be light, dark or system");
      }
      update.colorMode = dto.colorMode;
    }
    if (typeof dto.animationsEnabled === "boolean") update.animationsEnabled = dto.animationsEnabled;
    if (typeof dto.reducedMotion === "boolean") update.reducedMotion = dto.reducedMotion;
    if (dto.animationPreset !== undefined) {
      if (!settings.allowCustomerAnimations) {
        throw new ForbiddenException("Animation preferences are disabled by your administrator");
      }
      if (typeof dto.animationPreset !== "string" || !(ANIMATION_PRESET_IDS as string[]).includes(dto.animationPreset)) {
        throw new BadRequestException("Unknown animation preset");
      }
      update.animationPreset = dto.animationPreset;
    }

    const pref = await this.prefs.findOneAndUpdate(
      { userId: new Types.ObjectId(userId) },
      { $set: update },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    return pref;
  }

  async resetUserPreferences(userId: string) {
    await this.prefs.deleteOne({ userId: new Types.ObjectId(userId) });
    return { ok: true };
  }

  async stats() {
    const [published, total, prefs] = await Promise.all([
      this.themes.countDocuments({ isPublished: true }),
      this.themes.countDocuments(),
      this.prefs.countDocuments({ themeKey: { $exists: true, $ne: null } }),
    ]);
    return { publishedThemes: published, totalThemes: total, customerPreferences: prefs };
  }
}
