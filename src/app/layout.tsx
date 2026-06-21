import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "LLMTokenLedger",
  description: "Track LLM token spend from your backend."
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
