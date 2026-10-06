import { createRoot } from "react-dom/client";
import { supabase } from "./integrations/supabase/client";

createRoot(document.getElementById("root")!).render(<h1>{String(Boolean(supabase))}</h1>);
