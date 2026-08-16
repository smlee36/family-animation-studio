import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "우리집 Animation Studio",
  description: "우리 가족의 하루를 따뜻한 애니메이션으로 만드는 비공개 스튜디오",
  applicationName: "우리집 Animation Studio",
  appleWebApp: {
    capable: true,
    statusBarStyle: "default",
    title: "Animation Studio",
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
  themeColor: "#f7f1e7",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="ko">
      <body>{children}</body>
    </html>
  );
}
