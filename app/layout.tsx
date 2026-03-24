import type { Metadata } from "next";
import { Cormorant_Garamond, IBM_Plex_Sans_KR } from "next/font/google";
import "./globals.css";

const bodyFont = IBM_Plex_Sans_KR({
  weight: ["400", "500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-body",
});

const displayFont = Cormorant_Garamond({
  weight: ["500", "600", "700"],
  subsets: ["latin"],
  display: "swap",
  variable: "--font-display",
});

export const metadata: Metadata = {
  title: "제주 버스 가이드 플래너",
  description: "제주 버스 기반 여행 동선 검색, 계획, 실행을 이어주는 플래너",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko" className={`${bodyFont.variable} ${displayFont.variable}`}>
      <body className="font-sans text-ink antialiased">{children}</body>
    </html>
  );
}
