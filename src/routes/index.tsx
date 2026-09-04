import { createFileRoute } from "@tanstack/react-router";
import { SpectrumApp } from "@/components/spectrum-app";

export const Route = createFileRoute("/")({ component: Home });

function Home() {
  return <SpectrumApp />;
}
