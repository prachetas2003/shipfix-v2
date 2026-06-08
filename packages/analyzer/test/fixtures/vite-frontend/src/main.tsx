import { createRoot } from "react-dom/client";

const apiUrl = import.meta.env.VITE_API_URL;

function App() {
  return <div>API: {apiUrl}</div>;
}

createRoot(document.getElementById("root")!).render(<App />);
