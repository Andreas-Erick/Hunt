/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Enabled only by the GitHub Release desktop packager so local `next start` is unchanged.
  ...(process.env.HUNT_STANDALONE === "1" ? { output: "standalone" } : {}),
};

export default nextConfig;
