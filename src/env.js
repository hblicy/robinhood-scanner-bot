import fs from "node:fs";
import dotenv from "dotenv";

export function readEnvFile(file) {
  if (!fs.existsSync(file)) return {};
  return dotenv.parse(fs.readFileSync(file));
}
