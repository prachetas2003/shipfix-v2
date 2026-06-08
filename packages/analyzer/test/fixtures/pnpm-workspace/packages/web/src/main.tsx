import { createRoot } from "react-dom/client";

const apiUrl = import.meta.env.VITE_API_URL;

createRoot(document.getElementById("root")!).render(<div>{apiUrl}</div>);
