// The backend URL comes from the environment at build time — no hardcoding.
const API_URL = import.meta.env.VITE_API_URL;

export async function fetchTodos(): Promise<unknown> {
  const res = await fetch(`${API_URL}/todos`);
  return res.json();
}

document.getElementById("root")!.textContent = "golden fullstack";
