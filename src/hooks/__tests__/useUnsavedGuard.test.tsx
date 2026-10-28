import { describe, it, expect, vi, afterEach } from "vitest";
import { act, render } from "@testing-library/react";
import {
  MemoryRouter,
  Route,
  Routes,
  useLocation,
  useNavigate,
  type NavigateFunction,
} from "react-router-dom";
import { useUnsavedGuard } from "@/hooks/useUnsavedGuard";

let nav: NavigateFunction;
let guard: ReturnType<typeof useUnsavedGuard>;

function Editor({ dirty }: { dirty: boolean }) {
  guard = useUnsavedGuard(dirty);
  return null;
}

function Probe() {
  nav = useNavigate();
  return <div data-testid="path">{useLocation().pathname}</div>;
}

function renderAt(dirty: boolean) {
  return render(
    <MemoryRouter initialEntries={["/edit"]}>
      <Probe />
      <Routes>
        <Route path="/edit" element={<Editor dirty={dirty} />} />
        <Route path="*" element={null} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => vi.restoreAllMocks());

describe("useUnsavedGuard", () => {
  it("asks before a programmatic navigate() and stays when declined", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(false);
    const { getByTestId } = renderAt(true);
    act(() => nav("/elsewhere"));
    expect(confirm).toHaveBeenCalledOnce();
    expect(getByTestId("path").textContent).toBe("/edit");
  });

  it("navigates when the user confirms", () => {
    vi.spyOn(window, "confirm").mockReturnValue(true);
    const { getByTestId } = renderAt(true);
    act(() => nav("/elsewhere"));
    expect(getByTestId("path").textContent).toBe("/elsewhere");
  });

  it("doesn't ask when clean, or after release()", () => {
    const confirm = vi.spyOn(window, "confirm");
    const clean = renderAt(false);
    act(() => nav("/a"));
    expect(clean.getByTestId("path").textContent).toBe("/a");
    clean.unmount();

    const dirty = renderAt(true);
    act(() => guard.release());
    act(() => nav("/b"));
    expect(dirty.getByTestId("path").textContent).toBe("/b");
    expect(confirm).not.toHaveBeenCalled();
  });

  it("asks once when confirmLeave() precedes the navigate()", () => {
    const confirm = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { getByTestId } = renderAt(true);
    act(() => {
      if (guard.confirmLeave()) nav("/list");
    });
    expect(confirm).toHaveBeenCalledOnce();
    expect(getByTestId("path").textContent).toBe("/list");
  });
});
