import * as NodeFS from "node:fs";

const outputPath = process.argv[2];
let input = "";

process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  input += chunk;
});
process.stdin.on("end", () => {
  if (outputPath) {
    NodeFS.appendFileSync(outputPath, `${input}\n`);
  }
});
