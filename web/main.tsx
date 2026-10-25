import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import StudioPage from "./StudioPage";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <StudioPage />
  </StrictMode>,
);
