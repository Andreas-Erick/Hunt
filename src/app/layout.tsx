import type { Metadata, Viewport } from "next";
import { JetBrains_Mono, Space_Grotesk } from "next/font/google";
import "./globals.css";

// next/font downloads these at build time and serves them from /_next/static,
// so opening Hunt makes no request to Google. The variables feed globals.css
// (body) and the Tailwind `font-mono` / `font-display` families.
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
      { url: "/favicon.ico", sizes: "any" },
      { url: "/hunt-logo.png", type: "image/png", sizes: "512x512" },
    ],
    shortcut: "/favicon.ico",
    apple: "/hunt-logo.png",
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
      className={`dark ${spaceGrotesk.variable} ${jetbrainsMono.variable}`}
    >
      <body className="min-h-screen min-h-[100dvh] bg-[#0b0c0e] text-slate-100 antialiased selection:bg-[#00f0ff]/20 selection:text-[#00f0ff]">
        {children}
      </body>
    </html>
  );
}
