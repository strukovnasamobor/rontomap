import { IonPage, IonContent } from "@ionic/react";

export default function PageFixedLayout({ children, name, center = true }) {
  return (
    <IonPage>
      <IonContent id={`${name}-ioncontent`} scrollY={false}>
        <div className="main">
          <div className={`${name}${center ? " center" : ""}`}>{children}</div>
        </div>
      </IonContent>
    </IonPage>
  );
}
