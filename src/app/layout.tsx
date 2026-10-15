import type { Metadata } from "next";
import { Hind_Siliguri, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";

const bengaliSans = Hind_Siliguri({
  variable: "--font-bengali",
  subsets: ["latin", "bengali"],
  weight: ["300", "400", "500", "600", "700"],
});

const codeMono = JetBrains_Mono({
  variable: "--font-mono-code",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "XAUUSD AI Trading Agent — Phase 1 Audit",
  description:
    "GLM-চালিত XAUUSD ট্রেডিং অ্যানালিসিস সিস্টেম — Phase 1: Environment Audit & Foundation. Read-only, no order execution.",
  keywords: [
    "XAUUSD",
    "GLM",
    "z-ai",
    "trading agent",
    "MT5 bridge",
    "market structure",
    "risk engine",
  ],
  authors: [{ name: "XAUUSD AI Trading Agent" }],
  icons: { icon: "/gold-icon.svg" },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="bn" className="dark" suppressHydrationWarning>
      <body
        className={`${bengaliSans.variable} ${codeMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
