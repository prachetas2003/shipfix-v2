// BUG (deployment smell): backend URL is hardcoded to localhost.
const API_BASE = "http://localhost:3001";

export async function fetchTodos() {
  const res = await fetch(`${API_BASE}/todos`);
  return res.json();
}
