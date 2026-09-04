import { createRoot } from "react-dom/client";
import { SpectrumApp } from "@/components/spectrum-app";
import "./styles.css";

export function mount(el: HTMLElement): void {
  createRoot(el).render(<SpectrumApp />);
}
