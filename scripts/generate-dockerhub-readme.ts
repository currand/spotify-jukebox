/**
 * Prepare README.md for Docker Hub by removing screenshot HTML blocks
 * (Docker Hub markdown does not render them reliably).
 */
const input = process.env.INPUT ?? "README.md";
const output = process.env.OUTPUT ?? "docs/DOCKERHUB.md";

let content = await Bun.file(input).text();

content = content.replace(/<p align="center">[\s\S]*?<img[\s\S]*?<\/p>\n?/gi, "");
content = content.replace(/<p align="center"><em>[^<]*<\/em><\/p>\n?/gi, "");
content = content.replace(/\n{3,}/g, "\n\n");

await Bun.write(output, content);
