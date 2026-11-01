import type { Metadata } from "next";
import Link from "next/link";
import { connection } from "next/server";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { SiteHeader } from "@/components/site-header";
import { StepUpDialog } from "@/components/step-up-dialog";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "ACME Retail",
  description: "Shop home, apparel, and everyday goods. Payments in this demo are simulated.",
};

export default async function RootLayout({ children }: LayoutProps<"/">) {
  // Every page is rendered per request so Next.js can apply the CSP nonce set in src/proxy.ts.
  await connection();
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <SiteHeader />
        <main className="mx-auto w-full max-w-6xl flex-1 px-4 py-8">{children}</main>
        <StepUpDialog />
        <footer className="border-t border-line px-4 py-6 text-center text-sm text-muted">
          ACME Retail is a simulated store. No real payment is collected. <Link href="/privacy" className="text-accent">Privacy notice</Link>
        </footer>
      </body>
    </html>
  );
}
