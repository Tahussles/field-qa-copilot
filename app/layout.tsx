import type { Metadata, Viewport } from "next";
import { DM_Mono, Inter, Inter_Tight, JetBrains_Mono, Jost } from "next/font/google";

import { DEFAULT_THEME, THEME_COLOR, THEME_SCRIPT } from "@/lib/theme-config";
import "./globals.css";

// Poket theme (the default): Jost for display and body, DM Mono for IDs and numbers, both as on poketapp.com.
const jost = Jost({ variable: "--font-jost", subsets: ["latin"] });
const dmMono = DM_Mono({ variable: "--font-dm-mono", subsets: ["latin"], weight: ["400", "500"] });
// Linear theme: loaded only when it is switched on.
const inter = Inter({ variable: "--font-inter", subsets: ["latin"], preload: false });
const interTight = Inter_Tight({ variable: "--font-inter-tight", subsets: ["latin"], preload: false });
const jetbrains = JetBrains_Mono({ variable: "--font-jetbrains", subsets: ["latin"], preload: false });

export const metadata: Metadata = {
  title: "Field QA Copilot",
  description: "Flags likely fabricated field data submissions with explainable evidence.",
};

export const viewport: Viewport = { themeColor: THEME_COLOR[DEFAULT_THEME] };

export default function RootLayout({ children }: LayoutProps<"/">) {
  const fonts = [jost, dmMono, inter, interTight, jetbrains].map((f) => f.variable).join(" ");
  return (
    // The theme script may switch data-theme before React hydrates.
    <html lang="en" data-theme={DEFAULT_THEME} suppressHydrationWarning className={`${fonts} h-full antialiased`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: THEME_SCRIPT }} />
      </head>
      <body className="min-h-full">{children}</body>
    </html>
  );
}
