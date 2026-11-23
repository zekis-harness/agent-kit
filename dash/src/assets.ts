import { basename, join } from "node:path";

export async function buildAssets() {
  const build = await Bun.build({
    entrypoints: [join(import.meta.dir, "ui", "index.html")],
    target: "browser",
    minify: true,
    publicPath: "/",
    define: { "process.env.NODE_ENV": JSON.stringify("production") },
  });
  if (!build.success) throw new AggregateError(build.logs, "Dashboard asset build failed");
  const assets = new Map<string, Response>();
  for (const output of build.outputs) {
    const path = `/${basename(output.path)}`;
    const response = new Response(output, { headers: {
      "content-type": output.type,
      "cache-control": path.endsWith(".html") ? "no-cache" : "public, max-age=31536000, immutable",
      "x-content-type-options": "nosniff",
    } });
    assets.set(path, response);
    if (path === "/index.html") assets.set("/", response);
  }
  if (!assets.has("/")) throw new Error("Dashboard build produced no index.html");
  return {
    respond(request: Request) {
      const response = assets.get(new URL(request.url).pathname);
      return response ? response.clone() : new Response("Not found", { status: 404 });
    },
  };
}
