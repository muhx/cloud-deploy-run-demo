import type { Metadata } from "next";

export const metadata: Metadata = {
  title: "Hello World",
  description: "A simple Next.js 16 app deployed on Cloud Run",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
