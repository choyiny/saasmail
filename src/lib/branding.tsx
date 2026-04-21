import { createContext, useContext, useEffect, useState } from "react";

interface Branding {
  passkeyRequired: boolean;
}

const DEFAULT_BRANDING: Branding = {
  passkeyRequired: true,
};

interface BrandingContextValue extends Branding {
  loaded: boolean;
}

const BrandingContext = createContext<BrandingContextValue>({
  ...DEFAULT_BRANDING,
  loaded: false,
});

export function BrandingProvider({ children }: { children: React.ReactNode }) {
  const [branding, setBranding] = useState<BrandingContextValue>({
    ...DEFAULT_BRANDING,
    loaded: false,
  });

  useEffect(() => {
    fetch("/api/config")
      .then((r) => r.json() as Promise<Branding>)
      .then((b) => {
        setBranding({ ...b, loaded: true });
      })
      .catch(() => {
        setBranding((prev) => ({ ...prev, loaded: true }));
      });
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
