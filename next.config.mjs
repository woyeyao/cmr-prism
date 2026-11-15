const staticClassroom = process.env.NEXT_PUBLIC_STATIC_CLASSROOM === "1";
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";
if (!/^(?:\/[A-Za-z0-9._~-]+)*$/.test(basePath)) throw new Error("Invalid NEXT_PUBLIC_BASE_PATH");

/** @type {import('next').NextConfig} */
const config = {
  reactStrictMode: true,
  basePath,
  ...(staticClassroom ? {
    output: "export",
    // In export mode Next uses distDir for the final static output, with .next
    // as its intermediate build. Only the two *.pages.tsx entries are routes.
    distDir: "artifacts/pages",
    pageExtensions: ["pages.tsx"],
    trailingSlash: true,
    images: { unoptimized: true }
  } : {
    serverExternalPackages: ["@itk-wasm/image-io", "itk-wasm", "dcmjs", "yauzl"],
    experimental: { proxyClientMaxBodySize: "1gb" }
  })
};
export default config;
