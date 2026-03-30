import type { Metadata } from "next";
import type { ReactNode } from "react";
import "./globals.css";
import { DashboardLayout } from "@/components/layout/dashboard-layout";
import { QueryProvider } from "@/components/providers";

export const metadata: Metadata = {
  title: "BRAIN Dashboard",
  description: "Polymarket trading bot dashboard",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark" suppressHydrationWarning>
      <body className="antialiased">
        <QueryProvider>
          <DashboardLayout>{children}</DashboardLayout>
        </QueryProvider>
      </body>
    </html>
  );
}
