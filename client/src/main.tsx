import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import App from "./App";
import { ToastProvider } from "@/components/Toast";
import { installBackButton } from "@/platform/backButton";
import { installViewportVars } from "@/lib/viewport";

void installBackButton();
installViewportVars();

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BrowserRouter>
);
