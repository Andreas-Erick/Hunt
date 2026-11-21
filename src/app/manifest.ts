import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "HUNT — Make time for what matters",
    short_name: "Hunt",
    description:
      "Calm single-task focus, weekly quest hours, and done-list telemetry.",
    start_url: "/",
    display: "fullscreen",
    display_override: ["fullscreen", "standalone"],
    background_color: "#0b0c0e",
    theme_color: "#0b0c0e",
    icons: [
      {
        src: "/hunt-logo.png",
        sizes: "512x512",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
