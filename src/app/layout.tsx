import type { Metadata } from "next";
import { STORAGE_KEYS } from "@/lib/constants";
import { THEME_IDS } from "@/components/theme/theme-config";
import { Geist, Geist_Mono } from "next/font/google";
import { ThemeProvider } from "@/components/theme/theme-context";
import { HoverJanitor } from "@/components/charts/hover-janitor";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Hermetic",
  description: "Upload CSV files, ask questions, get visual answers",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script
          dangerouslySetInnerHTML={{
            // No-FOUC bootstrap, generated from the same constants the theme
            // provider uses — the keys and allow-list can no longer drift from
            // components/theme/theme-context (modularization M1-1d).
            __html: `(function(){try{var d=document.documentElement,t=localStorage.getItem(${JSON.stringify(
              STORAGE_KEYS.theme
            )});if(t&&${JSON.stringify(THEME_IDS)}.includes(t))d.setAttribute("data-theme",t);var m=localStorage.getItem(${JSON.stringify(
              STORAGE_KEYS.mode
            )});if(m==="dark")d.setAttribute("data-mode","dark");else if(m==="light")d.setAttribute("data-mode","light")}catch(e){}})()`,
          }}
        />
      </head>
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <HoverJanitor />
        <ThemeProvider>
          <a
            href="#main-content"
            className="sr-only focus:not-sr-only focus:absolute focus:z-50 focus:bg-surface-1 focus:px-4 focus:py-2 focus:text-accent"
          >
            Skip to content
          </a>
          {children}
        </ThemeProvider>
      </body>
    </html>
  );
}
