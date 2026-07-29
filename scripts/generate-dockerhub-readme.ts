/**
 * Prepare README.md for Docker Hub: rewrite HTML screenshot tags to absolute
 * GitHub raw URLs (dockerhub-description only completes markdown image syntax).
 */
const ref = process.env.GITHUB_REF_NAME ?? "main";
const repo = process.env.GITHUB_REPOSITORY ?? "currand/spotify-jukebox";
const input = process.env.INPUT ?? "README.md";
const output = process.env.OUTPUT ?? "docs/DOCKERHUB.md";
const rawBase = `https://github.com/${repo}/raw/${ref}/`;

let content = await Bun.file(input).text();

content = content.replace(
  /<img\s+src="(images\/[^"]+)"\s+alt="([^"]*)"(?:\s+width="[^"]*")?\s*\/?>/gi,
  (_, path: string, alt: string) => `![${alt}](${rawBase}${path})`,
);

await Bun.write(output, content);
