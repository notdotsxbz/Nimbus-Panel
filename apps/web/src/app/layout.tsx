import type { Metadata, Viewport } from "next";
import { AppearanceSync } from "@/components/appearance-sync";
import { BackgroundVideo } from "@/components/background-video";
import { NO_FLASH_SCRIPT } from "@/lib/theme";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "NIMBUS — Hosting Panel", template: "%s · NIMBUS" },
  description: "One Platform. Every Service. Every Device. Total Control.",
  manifest: "/manifest.webmanifest",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "NIMBUS" },
};

export const viewport: Viewport = {
  themeColor: "#000000",
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" suppressHydrationWarning data-animations="on">
      <head>
        {/* Applies the cached theme before first paint — no flash, no layout shift */}
        <script id="nimbus-theme-noflash" dangerouslySetInnerHTML={{ __html: NO_FLASH_SCRIPT }} />
      </head>
      <body className="font-sans">
        <BackgroundVideo />
        <AppearanceSync />
        {children}
      </body>
    </html>
  );
}
