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

registerSW({
  onNeedRefresh() {
    // Silent update: just reload the app
    window.location.reload();
  },
  onOfflineReady() {
    // App is ready to work offline, no action needed
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
