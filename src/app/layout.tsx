import type { Metadata, Viewport } from "next";
import { Hanken_Grotesk, JetBrains_Mono, Newsreader, Space_Grotesk } from "next/font/google";
import { LOOK_BOOT_SCRIPT } from "@/lib/lookPreference";
import { publicAssetUrl } from "@/lib/publicAsset";
import "./globals.css";

// next/font downloads these at build time and serves them from /_next/static,
// so opening Hunt makes no request to Google. The variables feed the font
// tokens in globals.css: Space Grotesk + JetBrains Mono for the Neon look,
// Hanken Grotesk + Newsreader for Dawn (ADR-0005).
const spaceGrotesk = Space_Grotesk({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-space-grotesk",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

const jetbrainsMono = JetBrains_Mono({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-jetbrains-mono",
  fallback: ["Cascadia Code", "Consolas", "ui-monospace", "monospace"],
});

const hankenGrotesk = Hanken_Grotesk({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-hanken-grotesk",
  fallback: ["Segoe UI", "system-ui", "sans-serif"],
});

const newsreader = Newsreader({
  weight: ["400", "500", "600"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-newsreader",
  fallback: ["Iowan Old Style", "Georgia", "serif"],
});

export const viewport: Viewport = {
  themeColor: "#0b0c0e",
  width: "device-width",
  initialScale: 1,
};

export const metadata: Metadata = {
  title: "Hunt — Make time for what matters",
  description:
    "Hunt — Calm single-task focus, weekly quest hours, and done-list telemetry.",
  appleWebApp: {
    capable: true,
    statusBarStyle: "black-translucent",
    title: "Hunt",
  },
  icons: {
    icon: [
      { url: publicAssetUrl("/favicon.ico"), sizes: "any" },
      { url: publicAssetUrl("/hunt-logo.png"), type: "image/png", sizes: "512x512" },
    ],
    shortcut: publicAssetUrl("/favicon.ico"),
    apple: publicAssetUrl("/hunt-logo.png"),
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`dark ${spaceGrotesk.variable} ${jetbrainsMono.variable} ${hankenGrotesk.variable} ${newsreader.variable}`}
      // The boot script sets data-theme before React hydrates.
      suppressHydrationWarning
    >
      <head>
        {/* Static string from lookPreference.ts: applies the saved look before first paint. */}
        <script dangerouslySetInnerHTML={{ __html: LOOK_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen min-h-[100dvh] bg-base text-slate-100 antialiased">
        {children}
      </body>
    </html>
  );
}
