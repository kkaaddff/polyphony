import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router";
import "./index.css";
import App from "./App";
import { ToastProvider } from "@/components/Toast";
import { installBackButton } from "@/platform/backButton";
import { installViewportVars } from "@/lib/viewport";
import { installVoiceReceiver } from "@/lib/voiceReceiver";

void installBackButton();
installViewportVars();
installVoiceReceiver();

createRoot(document.getElementById("root")!).render(
  <BrowserRouter>
    <ToastProvider>
      <App />
    </ToastProvider>
  </BrowserRouter>
);
