import { defineConfig } from "drizzle-kit";

function readEnv(name: string): string {
  return String(process.env[name] || "").trim();
}

function firstEnv(names: string[]): string {
  for (const name of names) {
    const value = readEnv(name);
    if (value) return value;
  }
  return "";
}

function resolveDatabaseUrl(): string {
  const explicitUrl = firstEnv([
    "DATABASE_URL",
    "POSTGRES_URL",
    "POSTGRESQL_URL",
    "PGDATABASE_URL",
    "DATABASE_PRIVATE_URL",
  ]);
  if (explicitUrl) return explicitUrl;

  const host = firstEnv(["DB_HOST", "PGHOST", "POSTGRES_HOST", "POSTGRESQL_HOST"]);
  const database = firstEnv(["DB_NAME", "DB_DATABASE", "POSTGRES_DB", "POSTGRES_DATABASE", "PGDATABASE"]);
  const user = firstEnv(["DB_USER", "DB_USERNAME", "POSTGRES_USER", "POSTGRES_USERNAME", "PGUSER"]);
  const password = firstEnv(["DB_PASSWORD", "POSTGRES_PASSWORD", "PGPASSWORD"]);
  const port = firstEnv(["DB_PORT", "PGPORT", "POSTGRES_PORT", "POSTGRESQL_PORT"]) || "5432";

  if (!host || !database || !user) return "";

  const auth = password ? `${encodeURIComponent(user)}:${encodeURIComponent(password)}` : encodeURIComponent(user);
  return `postgres://${auth}@${host}:${encodeURIComponent(port)}/${encodeURIComponent(database)}`;
}

const databaseUrl = resolveDatabaseUrl();

if (!databaseUrl) {
  throw new Error("Database connection is not configured. Set DATABASE_URL or DB_HOST/DB_PORT/DB_NAME/DB_USER/DB_PASSWORD.");
}

export default defineConfig({
  out: "./migrations",
  schema: "./shared/schema.ts",
  dialect: "postgresql",
  dbCredentials: {
    url: databaseUrl,
  },
});
