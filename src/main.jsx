import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import { AppContextProvider } from "./AppContext";
import { IonApp } from "@ionic/react";
import { IonReactRouter } from "@ionic/react-router";
import { registerSW } from "virtual:pwa-register";

import "@ionic/react/css/core.css";
import "@ionic/react/css/normalize.css";
import "@ionic/react/css/structure.css";
import "@ionic/react/css/typography.css";

import "@ionic/react/css/padding.css";
import "@ionic/react/css/float-elements.css";
import "@ionic/react/css/text-alignment.css";
import "@ionic/react/css/text-transformation.css";
import "@ionic/react/css/flex-utils.css";
import "@ionic/react/css/display.css";

import "./theme/variables.css";

import { setupIonicReact } from "@ionic/react";
setupIonicReact({
  mode: "md", // forces Material Design everywhere
});

// registerType is "autoUpdate" (vite.config.js): a newly-detected service
// worker is activated and the page reloaded automatically. But the browser
// only *checks* for a new SW on navigation, and the Android WebView keeps the
// old SW alive across relaunches — so deploys weren't picked up without
// clearing app data. Trigger an update check whenever the app returns to the
// foreground so new deploys are detected and auto-applied on the next resume.
registerSW({
  immediate: true,
  onRegisteredSW(swUrl, registration) {
    if (!registration) return;
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") registration.update().catch(() => {});
    });
  },
  onOfflineReady() {
    // App is ready to work offline, no action needed.
  },
});

createRoot(document.getElementById("root")).render(
  <StrictMode>
    <AppContextProvider>
      <IonApp>
        <IonReactRouter>
          <App />
        </IonReactRouter>
      </IonApp>
    </AppContextProvider>
  </StrictMode>,
);
