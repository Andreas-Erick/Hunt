/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // The app never uses next/image; disabling the optimizer turns off the /_next/image
  // endpoint and its image-optimizer advisories on the LAN-exposed server.
  images: { unoptimized: true },
  // Enabled only by the GitHub Release desktop packager so local `next start` is unchanged.
  ...(process.env.HUNT_STANDALONE === "1" ? { output: "standalone" } : {}),
  async headers() {
    return [
      {
        source: "/(favicon\\.ico|hunt-logo\\.png)",
        headers: [
          {
            key: "Cache-Control",
            value: "no-cache, must-revalidate",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
