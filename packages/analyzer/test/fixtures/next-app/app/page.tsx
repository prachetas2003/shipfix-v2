export default function Home() {
  const apiUrl = process.env.NEXT_PUBLIC_API_URL;
  return <main>API base: {apiUrl}</main>;
}
