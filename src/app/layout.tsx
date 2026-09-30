import type { Metadata } from "next";
import "./globals.css";
import "./viewer-controls.css";
export const metadata: Metadata = { title: "CMR Prism · 心磁棱镜", description: "Cardiac magnetic resonance, in space and time." };
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body>{children}</body></html>;
}
