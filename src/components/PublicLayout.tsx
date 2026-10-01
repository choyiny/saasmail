import { lazy, Suspense } from "react";
import { Outlet } from "react-router-dom";
import Footer from "@/components/Footer";
import { useReducedAnimations } from "@/hooks/useReducedAnimations";

// Lazy-load the shader so the auth pages can paint instantly while the
// (small) shader chunk fetches in the background. Only requested when the
// device can afford the GPU work.
const GrainGradient = lazy(() =>
  import("@paper-design/shaders-react").then((mod) => ({
    default: mod.GrainGradient,
  })),
);

/**
 * Wraps every public route (login, onboarding, invite, setup-passkey)
 * with the same animated shader backdrop givefeedback.dev uses on its
 * auth screen — violet/lime grain gradient on a near-black canvas.
 *
 * On lower-spec devices (Save-Data, slow connection, low memory/cores) or
 * when the user prefers reduced motion, we render a static CSS gradient
 * instead. Same look, zero ongoing GPU/CPU cost.
 */
export default function PublicLayout() {
  const reduced = useReducedAnimations();

  return (
    <div className="relative flex min-h-screen flex-col overflow-hidden text-white">
      {/* Backdrop layer */}
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 bg-[#0a0a0a]" />
        {reduced ? (
          <div className="brand-backdrop absolute inset-0" aria-hidden />
        ) : (
          <Suspense
            fallback={
              <div className="brand-backdrop absolute inset-0" aria-hidden />
            }
          >
            <GrainGradient
              colors={["#7C5CFC", "#BFFF00", "#6366f1", "#3b0764"]}
              colorBack="#0a0a0a"
              softness={0.4}
              intensity={0.7}
              noise={0.2}
              shape="wave"
              speed={0.4}
              scale={1.2}
              rotation={200}
              offsetX={-0.1}
              offsetY={0.15}
              style={{ width: "100%", height: "100%" }}
            />
          </Suspense>
        )}
      </div>

      {/* Dark overlays for depth and contrast */}
      <div
        className="pointer-events-none absolute inset-0 z-[1] bg-black/30"
        aria-hidden
      />
      <div
        className="pointer-events-none absolute inset-0 z-[1] bg-gradient-to-t from-black/50 via-transparent to-black/20"
        aria-hidden
      />

      <main className="relative z-10 flex flex-1 items-center justify-center px-4 py-16">
        <Outlet />
      </main>

      <div className="relative z-10">
        <Footer variant="dark" />
      </div>
    </div>
  );
}
