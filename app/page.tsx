import { getClientIp } from "@/lib/get-ip";

export default async function Home() {
  const ip = await getClientIp();
  const commitSha = process.env.NEXT_PUBLIC_COMMIT_SHA ?? "dev";

  return (
    <main
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "1rem",
        minHeight: "100vh",
        alignItems: "center",
        justifyContent: "center",
        fontFamily: "system-ui, sans-serif",
      }}
    >
      <h1>Hello, World! 👋</h1>
      <p>
        Your IP address: <strong>{ip}</strong>
      </p>
      <p style={{ color: "#888", fontSize: "0.875rem" }}>
        commit <code>{commitSha}</code>
      </p>
    </main>
  );
}
