import { createContext, useContext, useEffect, useState } from "react";

interface Branding {
  appName: string;
  logoLetter: string;
}

const DEFAULT_BRANDING: Branding = {
  appName: "saasmail",
  logoLetter: "s",
};

const BrandingContext = createContext<Branding>(DEFAULT_BRANDING);

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = useState<Branding>(DEFAULT_BRANDING);

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json() as Promise<Branding>)
      .then((b) => {
        setBranding(b);
        document.title = b.appName;
      })
      .catch(() => {});
  }, []);

  return (
    <BrandingContext.Provider value={branding}>
      {children}
    </BrandingContext.Provider>
  );
}

export function useBranding() {
  return useContext(BrandingContext);
}
