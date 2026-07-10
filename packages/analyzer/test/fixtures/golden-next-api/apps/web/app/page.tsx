// Backend URL comes from the environment at build time — no hardcoding.
const API_URL = process.env.NEXT_PUBLIC_API_URL;

export default function Home() {
  return (
    <main>
      <h1>Golden Next+API fixture</h1>
      <p>API: {API_URL ?? "unset"}</p>
    </main>
  );
}
