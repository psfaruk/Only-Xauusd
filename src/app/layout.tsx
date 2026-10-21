import type { Metadata } from "next";
import { Hind_Siliguri, JetBrains_Mono } from "next/font/google";
import { ThemeProvider } from "next-themes";
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
  title: "XAUUSD AI Trading Agent — Trading Terminal",
  description:
    "GLM-চালিত XAUUSD ট্রেডিং টার্মিনাল — ডিটারমিনিস্টিক মার্কেট-স্ট্রাকচার ইঞ্জিন, লাইভ MT5 ডেটা ও বাংলা AI চ্যাট।",
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
        {/* Task 39 (UI-03) — dark mode is the PRIMARY terminal experience;
         * light mode is fully designed via the same token system. The class
         * on <html> is SSR-default "dark" so there is no theme flash. */}
        <ThemeProvider
          attribute="class"
          defaultTheme="dark"
          enableSystem
          disableTransitionOnChange
        >
          {children}
          <Toaster />
        </ThemeProvider>
      </body>
    </html>
  );
}
