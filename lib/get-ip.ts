import { headers } from "next/headers";

/**
 * Resolve the client's IP address from the incoming request headers.
 *
 * Behind a proxy/load balancer (Cloud Run, Vercel, nginx, ...) the original
 * client IP is forwarded in headers rather than available on the socket.
 * We check the common ones in priority order; `x-forwarded-for` may contain a
 * comma-separated chain, in which case the first entry is the original client.
 */
export async function getClientIp(): Promise<string> {
  const headerList = await headers();

  const forwardedFor = headerList.get("x-forwarded-for");
  if (forwardedFor) {
    const [first] = forwardedFor.split(",");
    if (first?.trim()) return first.trim();
  }

  return (
    headerList.get("x-real-ip") ??
    headerList.get("cf-connecting-ip") ??
    "unknown"
  );
}
