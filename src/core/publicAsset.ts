/** Root-relative public assets work both locally and under a Pages project path. */
export function publicAsset(path: string): string {
  if (!path.startsWith("/") || path.startsWith("//")) throw new Error("Expected a root-relative public asset path");
  return `${process.env.NEXT_PUBLIC_BASE_PATH ?? ""}${path}`;
}
