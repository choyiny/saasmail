export interface ExportReadyEvent {
  inbox: string;
  jobId: string;
}

const EVENT_NAME = "saasmail:export-ready";

export function dispatchExportReady(detail: ExportReadyEvent): void {
  window.dispatchEvent(new CustomEvent(EVENT_NAME, { detail }));
}

export function onExportReady(
  listener: (detail: ExportReadyEvent) => void,
): () => void {
  const handler = (event: Event) => {
    const detail = (event as CustomEvent<ExportReadyEvent>).detail;
    if (detail) listener(detail);
  };
  window.addEventListener(EVENT_NAME, handler);
  return () => window.removeEventListener(EVENT_NAME, handler);
}
