import type { Metadata } from "next";
import { Noto_Sans_SC, Space_Grotesk, Space_Mono } from "next/font/google";
import "katex/dist/katex.min.css";
import "./globals.css";

const spaceGrotesk = Space_Grotesk({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  variable: "--font-display",
  display: "swap",
});

const spaceMono = Space_Mono({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-mono-display",
  display: "swap",
});

const notoSansSC = Noto_Sans_SC({
  weight: ["400", "700"],
  subsets: ["latin"],
  variable: "--font-cjk",
  display: "swap",
});

export const metadata: Metadata = {
  title: "Ripple",
  description: "An elegant AI agent client",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${spaceGrotesk.variable} ${spaceMono.variable} ${notoSansSC.variable} flex min-h-screen flex-col font-[family-name:var(--font-sans)] antialiased`}
      >
        {children}
      </body>
    </html>
  );
}
