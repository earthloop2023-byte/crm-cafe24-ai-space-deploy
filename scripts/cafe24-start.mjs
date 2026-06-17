import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import path from "node:path";

const rootDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

process.env.NODE_ENV = process.env.NODE_ENV || "production";

function hasDatabaseEnv() {
  const explicitKeys = [
    "DATABASE_URL",
    "DATABASE_PRIVATE_URL",
    "POSTGRES_URL",
    "POSTGRESQL_URL",
    "POSTGRES_PRISMA_URL",
    "PGDATABASE_URL",
    "DB_URL",
  ];
  if (explicitKeys.some((key) => String(process.env[key] || "").trim())) return true;

  const host = process.env.DB_HOST || process.env.PGHOST || process.env.POSTGRES_HOST || process.env.POSTGRESQL_HOST;
  const database =
    process.env.DB_NAME ||
    process.env.DB_DATABASE ||
    process.env.POSTGRES_DB ||
    process.env.POSTGRES_DATABASE ||
    process.env.PGDATABASE;
  const user = process.env.DB_USER || process.env.DB_USERNAME || process.env.POSTGRES_USER || process.env.PGUSER;
  return Boolean(host && database && user);
}

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd: rootDir,
      env: process.env,
      shell: process.platform === "win32",
      stdio: "inherit",
    });

    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (code === 0) {
        resolve();
        return;
      }
      reject(new Error(`${command} ${args.join(" ")} exited with ${code ?? signal}`));
    });
  });
}

console.log(`[cafe24-start] NODE_ENV=${process.env.NODE_ENV}`);

await import("../dist/index.js");

if (String(process.env.SKIP_DB_PUSH || "").trim().toLowerCase() !== "true" && hasDatabaseEnv()) {
  const npxCommand = process.platform === "win32" ? "npx.cmd" : "npx";
  const args = ["--yes", "drizzle-kit", "push", "--config", "drizzle.config.ts", "--yes"];
  console.log(`[cafe24-start] running ${npxCommand} ${args.join(" ")}`);
  void run(npxCommand, args)
    .then(() => console.log("[cafe24-start] database schema push completed"))
    .catch((error) => console.error("[cafe24-start] database schema push failed:", error));
} else {
  console.log("[cafe24-start] database schema push skipped because database env is not configured");
}
