import "./App.css";
import {Route} from "react-router-dom";
import { getConfig, IonRouterOutlet } from "@ionic/react";

import Map from "./pages/Map";
import PageNotFound from "./pages/PageNotFound";

export default function App() {
  const config = getConfig();
  config.set('animated', false);

  return (
    <IonRouterOutlet>
      <Route exact path={["/"]} component={Map} />
      <Route component={PageNotFound} />
    </IonRouterOutlet>
  );
}