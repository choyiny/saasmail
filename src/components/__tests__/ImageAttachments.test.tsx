import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import ImageAttachments, {
  splitAttachments,
} from "@/components/ImageAttachments";
import type { Attachment } from "@/lib/api";

const att = (over: Partial<Attachment> & { id: string }): Attachment => ({
  emailId: "e1",
  filename: `${over.id}.png`,
  contentType: "image/png",
  size: 1024,
  contentId: null,
  ...over,
});

describe("splitAttachments", () => {
  it("previews raster images, downloads the rest, and drops embedded CID images", () => {
    const { images, files } = splitAttachments([
      att({ id: "png" }),
      att({ id: "jpg", contentType: "IMAGE/JPEG; name=x.jpg" }),
      // An SVG is an image, but served from our origin it can run script.
      att({ id: "svg", contentType: "image/svg+xml" }),
      att({ id: "pdf", contentType: "application/pdf" }),
      att({ id: "cid", contentId: "logo@x" }),
    ]);
    expect(images.map((a) => a.id)).toEqual(["png", "jpg"]);
    expect(files.map((a) => a.id)).toEqual(["svg", "pdf"]);
  });

  it("handles a message with no attachments", () => {
    expect(splitAttachments(undefined)).toEqual({ images: [], files: [] });
  });
});

describe("ImageAttachments", () => {
  const images = [att({ id: "a" }), att({ id: "b" })];

  it("renders thumbnails from the inline route", () => {
    render(<ImageAttachments images={images} />);
    const img = screen.getByAltText("a.png") as HTMLImageElement;
    expect(img.getAttribute("src")).toBe("/api/attachments/a/inline");
  });

  it("opens the clicked image in the viewer instead of downloading it", () => {
    const parentClick = vi.fn();
    render(
      <div onClick={parentClick}>
        <ImageAttachments images={images} />
      </div>,
    );

    fireEvent.click(screen.getByTestId("image-attachment-b"));

    const viewer = screen.getByTestId("image-viewer");
    expect(viewer.textContent).toContain("b.png");
    expect(viewer.textContent).toContain("2 / 2");
    expect(
      screen
        .getByRole("link", { name: /download b\.png/i })
        .getAttribute("href"),
    ).toBe("/api/attachments/b");
    // A thread row must not also toggle or mark-read.
    expect(parentClick).not.toHaveBeenCalled();
  });

  it("steps between images with the arrows and the keyboard, wrapping around", () => {
    render(<ImageAttachments images={images} />);
    fireEvent.click(screen.getByTestId("image-attachment-a"));

    fireEvent.click(screen.getByRole("button", { name: /next image/i }));
    expect(screen.getByTestId("image-viewer").textContent).toContain("b.png");

    fireEvent.keyDown(window, { key: "ArrowRight" });
    expect(screen.getByTestId("image-viewer").textContent).toContain("a.png");

    fireEvent.keyDown(window, { key: "ArrowLeft" });
    expect(screen.getByTestId("image-viewer").textContent).toContain("b.png");
  });

  it("closes from the close button", () => {
    render(<ImageAttachments images={images} />);
    fireEvent.click(screen.getByTestId("image-attachment-a"));

    fireEvent.click(screen.getByRole("button", { name: /^close$/i }));
    expect(screen.queryByTestId("image-viewer")).toBeNull();
  });

  it("renders nothing without images", () => {
    const { container } = render(<ImageAttachments images={[]} />);
    expect(container.innerHTML).toBe("");
  });
});
