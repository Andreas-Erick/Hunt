import type { Metadata, Viewport } from "next";
import "./globals.css";

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
    <html lang="en" className="dark">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500;600;700&family=Space+Grotesk:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="min-h-screen min-h-[100dvh] bg-[#0b0c0e] text-slate-100 antialiased selection:bg-[#00f0ff]/20 selection:text-[#00f0ff]">
        {children}
      </body>
    </html>
  );
}
