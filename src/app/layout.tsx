import type { Metadata } from "next";
import { Cal_Sans, Poppins } from "next/font/google";
import "./globals.css";

const calSans = Cal_Sans({
  variable: "--font-cal-sans",
  subsets: ["latin"],
  weight: "400",
});

const poppins = Poppins({
  variable: "--font-poppins",
  subsets: ["latin"],
  weight: ["300", "400", "500", "600"],
});

export const metadata: Metadata = {
  title: "SafeSpace",
  description: "Crop short-form videos around social UI overlays",
};

export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body className={`${calSans.variable} ${poppins.variable} antialiased`}>
        {children}
      </body>
    </html>
  );
}
