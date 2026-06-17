import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pool } from "./db";

const APPLY_SETTING_KEY = "data_mapping_260606_applied";
const LOCAL_DATA_LABEL = "260606_임시데이터";
const SERVER_BACKUP_LABEL = "260606_백업데이터";

const TABLE_ALIASES: Record<string, string> = {
  users: "users",
  customers: "customers",
  contacts: "contacts",
  deals: "deals",
  dealTimelines: "deal_timelines",
  activities: "activities",
  payments: "payments",
  systemLogs: "system_logs",
  products: "products",
  productRateHistories: "product_rate_histories",
  contracts: "contracts",
  refunds: "refunds",
  keeps: "keeps",
  deposits: "deposits",
  notices: "notices",
  pagePermissions: "page_permissions",
  systemSettings: "system_settings",
  importBatches: "import_batches",
  importStagingRows: "import_staging_rows",
  importMappings: "import_mappings",
};

const BACKUP_TABLES = [
  "users",
  "customers",
  "contacts",
  "deals",
  "deal_timelines",
  "activities",
  "payments",
  "system_logs",
  "products",
  "product_rate_histories",
  "contracts",
  "refunds",
  "keeps",
  "deposits",
  "notices",
  "page_permissions",
  "system_settings",
  "import_batches",
  "import_staging_rows",
  "import_mappings",
];

const INSERT_ORDER = [
  "users",
  "customers",
  "contacts",
  "products",
  "product_rate_histories",
  "deals",
  "deal_timelines",
  "activities",
  "contracts",
  "payments",
  "deposits",
  "refunds",
  "keeps",
  "notices",
  "page_permissions",
  "system_settings",
  "system_logs",
  "import_batches",
  "import_staging_rows",
  "import_mappings",
];

function quoteIdentifier(name: string): string {
  return `"${String(name).replace(/"/g, '""')}"`;
}

function toSnakeCase(key: string): string {
  return String(key)
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[ -]+/g, "_")
    .toLowerCase();
}

function normalizeTables(payload: unknown): Record<string, unknown[]> {
  const raw = payload && typeof payload === "object" && "tables" in payload
    ? (payload as { tables?: unknown }).tables
    : payload;
  if (!raw || typeof raw !== "object") return {};

  const tables: Record<string, unknown[]> = {};
  for (const [key, rows] of Object.entries(raw as Record<string, unknown>)) {
    if (!Array.isArray(rows)) continue;
    const tableName = TABLE_ALIASES[key] || toSnakeCase(key);
    if (tableName === "database_backups") continue;
    tables[tableName] = rows;
  }
  return tables;
}

function convertValueForColumn(value: unknown, udtName: string): unknown {
  if (value === undefined) return null;
  if (value === null) return null;
  if ((udtName === "json" || udtName === "jsonb") && typeof value === "object") return JSON.stringify(value);
  return value;
}

async function getPublicTableNames(client: any): Promise<string[]> {
  const result = await client.query(`
    SELECT table_name
    FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
    ORDER BY table_name
  `);
  return result.rows.map((row: { table_name: string }) => String(row.table_name));
}

async function getTableMetadata(client: any, tableName: string) {
  const result = await client.query(
    `
      SELECT column_name, udt_name
      FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = $1
      ORDER BY ordinal_position
    `,
    [tableName],
  );
  const columns = result.rows.map((row: { column_name: string }) => String(row.column_name));
  const typeByColumn = Object.fromEntries(
    result.rows.map((row: { column_name: string; udt_name: string }) => [
      String(row.column_name),
      String(row.udt_name),
    ]),
  );
  return { columns, typeByColumn };
}

function mapRowToColumns(row: unknown, knownColumns: string[]) {
  const mapped: Record<string, unknown> = {};
  const columnSet = new Set(knownColumns);
  if (!row || typeof row !== "object") return mapped;

  for (const [rawKey, rawValue] of Object.entries(row as Record<string, unknown>)) {
    if (rawKey === "__meta") continue;
    if (columnSet.has(rawKey)) {
      mapped[rawKey] = rawValue;
      continue;
    }
    const snake = toSnakeCase(rawKey);
    if (columnSet.has(snake)) mapped[snake] = rawValue;
  }
  return mapped;
}

async function insertRows(client: any, tableName: string, rawRows: unknown[]): Promise<number> {
  if (!rawRows.length) return 0;
  const { columns, typeByColumn } = await getTableMetadata(client, tableName);
  if (!columns.length) throw new Error(`Table not found or has no columns: ${tableName}`);

  const normalizedRows = rawRows.map((row) => mapRowToColumns(row, columns));
  const activeColumns = columns.filter((column: string) => normalizedRows.some((row) => Object.hasOwn(row, column)));
  if (!activeColumns.length) return 0;

  const batchSize = Math.min(1000, Math.max(1, Math.floor(60000 / activeColumns.length)));
  let inserted = 0;
  for (let offset = 0; offset < normalizedRows.length; offset += batchSize) {
    const batch = normalizedRows.slice(offset, offset + batchSize);
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIndex = 1;

    for (const row of batch) {
      const slot: string[] = [];
      for (const column of activeColumns) {
        values.push(convertValueForColumn(row[column], typeByColumn[column]));
        slot.push(`$${paramIndex}`);
        paramIndex += 1;
      }
      placeholders.push(`(${slot.join(",")})`);
    }

    await client.query(
      `
        INSERT INTO ${quoteIdentifier(tableName)} (${activeColumns.map(quoteIdentifier).join(",")})
        VALUES ${placeholders.join(",")}
      `,
      values,
    );
    inserted += batch.length;
  }
  return inserted;
}

async function collectServerBackup(client: any) {
  const tables: Record<string, unknown[]> = {};
  const counts: Record<string, number> = {};
  for (const table of BACKUP_TABLES) {
    const result = await client.query(`SELECT * FROM ${quoteIdentifier(table)}`);
    tables[table] = result.rows;
    counts[table] = result.rows.length;
  }
  return {
    label: SERVER_BACKUP_LABEL,
    backupType: "json",
    backupVersion: 2,
    createdAt: new Date().toISOString(),
    tables,
    counts,
  };
}

async function writeServerBackup(client: any, backupPayload: unknown) {
  const data = JSON.stringify(backupPayload);
  await client.query(
    `
      INSERT INTO database_backups (label, created_by_name, created_by_user_id, table_counts, size_bytes, data)
      VALUES ($1, $2, NULL, $3, $4, $5)
    `,
    [
      SERVER_BACKUP_LABEL,
      "260606 서버 자동 백업",
      JSON.stringify((backupPayload as { counts?: unknown }).counts || {}),
      Buffer.byteLength(data, "utf8"),
      data,
    ],
  );
}

async function hasAppliedMarker(client: any): Promise<boolean> {
  const result = await client.query("SELECT setting_value FROM system_settings WHERE setting_key = $1 LIMIT 1", [
    APPLY_SETTING_KEY,
  ]);
  return String(result.rows[0]?.setting_value || "") === "true";
}

async function writeAppliedMarker(client: any, summary: unknown) {
  await client.query(
    `
      INSERT INTO system_settings (setting_key, setting_value)
      VALUES ($1, $2)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = excluded.setting_value
    `,
    [APPLY_SETTING_KEY, "true"],
  );
  await client.query(
    `
      INSERT INTO system_settings (setting_key, setting_value)
      VALUES ($1, $2)
      ON CONFLICT (setting_key) DO UPDATE SET setting_value = excluded.setting_value
    `,
    [`${APPLY_SETTING_KEY}_summary`, JSON.stringify(summary)],
  );
}

async function loadLocalDataSnapshot() {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const candidates = [
    path.resolve(currentDir, "../data-migrations/260606_임시데이터.backup.json"),
    path.resolve(process.cwd(), "data-migrations/260606_임시데이터.backup.json"),
  ];

  for (const candidate of candidates) {
    try {
      const raw = await fs.readFile(candidate, "utf8");
      return { filePath: candidate, payload: JSON.parse(raw) };
    } catch {}
  }
  throw new Error("260606 temporary data snapshot file was not found.");
}

export async function applyDataMapping260606IfNeeded() {
  const enabled = String(process.env.APPLY_260606_DATA_MAPPING || "true").trim().toLowerCase();
  if (["0", "false", "no", "off"].includes(enabled)) {
    console.log("[data-mapping-260606] skipped by APPLY_260606_DATA_MAPPING=false");
    return;
  }

  const client = await pool.connect();
  try {
    const publicTables = await getPublicTableNames(client);
    if (!publicTables.includes("system_settings") || !publicTables.includes("database_backups")) {
      console.log("[data-mapping-260606] skipped because required tables are not ready.");
      return;
    }
    if (await hasAppliedMarker(client)) {
      console.log("[data-mapping-260606] already applied.");
      return;
    }

    const { filePath, payload } = await loadLocalDataSnapshot();
    const tables = normalizeTables(payload);
    const tableNames = Object.keys(tables);
    const missingTables = tableNames.filter((tableName) => !publicTables.includes(tableName));
    if (missingTables.length) throw new Error(`Restore target is missing tables: ${missingTables.join(", ")}`);

    const restoreTableNames = tableNames.filter((tableName) => tableName !== "database_backups");
    const insertOrder = [
      ...INSERT_ORDER.filter((tableName) => restoreTableNames.includes(tableName)),
      ...restoreTableNames.filter((tableName) => !INSERT_ORDER.includes(tableName)).sort((a, b) => a.localeCompare(b)),
    ];

    await client.query("BEGIN");
    await client.query("SET LOCAL lock_timeout = '15s'");
    await client.query("SET LOCAL statement_timeout = '0'");

    const serverBackup = await collectServerBackup(client);
    await writeServerBackup(client, serverBackup);

    await client.query(`TRUNCATE TABLE ${restoreTableNames.map(quoteIdentifier).join(", ")} RESTART IDENTITY CASCADE`);

    const restoredCounts: Record<string, number> = {};
    for (const tableName of insertOrder) {
      restoredCounts[tableName] = await insertRows(client, tableName, tables[tableName] || []);
    }

    const summary = {
      backupLabel: SERVER_BACKUP_LABEL,
      restoredLabel: LOCAL_DATA_LABEL,
      snapshotFile: filePath,
      restoredCounts,
      appliedAt: new Date().toISOString(),
    };
    await writeAppliedMarker(client, summary);
    await client.query("COMMIT");
    console.log("[data-mapping-260606] applied", JSON.stringify(summary));
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    console.error("[data-mapping-260606] failed:", error);
    throw error;
  } finally {
    client.release();
  }
}
