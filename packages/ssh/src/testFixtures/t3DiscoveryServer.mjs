import * as NodeHttp from "node:http";

const mode = process.argv[2];
const port = Number.parseInt(process.argv[3] ?? "", 10);
if ((mode !== "generic" && mode !== "t3") || !Number.isInteger(port)) {
  process.exit(1);
}

const server = NodeHttp.createServer((request, response) => {
  if (request.url === "/.well-known/t3/environment" && mode === "t3") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ environmentId: "environment-1", serverVersion: "0.0.35" }));
    return;
  }
  response.writeHead(200, { "content-type": "text/plain" });
  response.end("ok");
});

server.listen(port, "127.0.0.1");
process.once("SIGTERM", () => process.exit(0));
