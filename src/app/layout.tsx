import type { Metadata } from "next";
import { I18nProvider } from "@/i18n";
import "./globals.css";
import "./viewer-controls.css";
const title = "CMR Prism · CMRI Viewer + CMR × 3D Learning";
const description = "A cardiac MRI viewer and interactive 3D anatomy tutorial. Freely slice a heart model, compare CMR references, and review local DICOM cine.";
const image = { url: "https://woyeyao.github.io/cmr-prism/social-preview.png", width: 1200, height: 630, alt: "CMR Prism: a freely sliced 3D heart beside a public cardiac MR reference" };
export const metadata: Metadata = {
  title,
  description,
  openGraph: { type: "website", siteName: "CMR Prism", title, description, url: "https://woyeyao.github.io/cmr-prism/", images: [image] },
  twitter: { card: "summary_large_image", title, description, images: [image] },
};
export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="zh-CN"><body><I18nProvider>{children}</I18nProvider></body></html>;
}
