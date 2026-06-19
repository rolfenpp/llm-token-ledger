import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Flight Recorder",
  description: "Lightweight LLM cost tracing for production systems."
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
