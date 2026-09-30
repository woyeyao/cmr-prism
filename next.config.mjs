/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  serverExternalPackages: ["@itk-wasm/image-io", "itk-wasm", "dcmjs", "yauzl"],
  experimental: { proxyClientMaxBodySize: "1gb" }
};
export default config;
