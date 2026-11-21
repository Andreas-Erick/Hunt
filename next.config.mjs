/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
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
