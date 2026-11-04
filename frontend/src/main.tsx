import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";
import { registerEngines } from "./render";

// Card D4: register the available render engines (sigma default, cosmos)
// before anything mounts a renderer — the Graph hook resolves the engine
// from the registry (and from the opened URL's `engine` key, card C3).
registerEngines();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>
);
