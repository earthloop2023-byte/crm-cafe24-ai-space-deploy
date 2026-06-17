import type { Express, Request, Response, NextFunction } from "express";
import { createServer, type Server } from "http";
import crypto from "crypto";
import type { PoolClient } from "pg";
import { storage } from "./storage";
import { hasDatabaseConfig, pool } from "./db";
import { z } from "zod";
import bcrypt from "bcryptjs";
import {
  insertUserSchema,
  insertCustomerSchema,
  insertContactSchema,
  insertDealSchema,
  insertActivitySchema,
  insertPaymentSchema,
  insertSystemLogSchema,
  insertProductSchema,
  insertContractSchema,
  insertRefundSchema,
  insertKeepSchema,
  insertDepositSchema,
  insertDealTimelineSchema,
  insertRegionalManagementFeeSchema,
  insertRegionalCustomerListSchema,
  insertNoticeSchema,
  importBatches,
  importStagingRows,
  importMappings,
  departmentDefaultPages,
  positionDefaultPages,
  users,
  customers,
  contacts,
  deals,
  dealTimelines,
  regionalManagementFees,
  regionalCustomerLists,
  activities,
  payments,
  systemLogs,
  products,
  contracts,
  refunds,
  keeps,
  deposits,
  notices,
  pagePermissions,
  systemSettings,
} from "@shared/schema";
import type { Contract, Deal, InsertDeal, InsertDeposit } from "@shared/schema";
import { addKoreanBusinessDays, normalizeToKoreanDateOnly } from "@shared/korean-business-days";
import { db } from "./db";
import { eq, inArray } from "drizzle-orm";
import multer from "multer";
import * as XLSX from "xlsx";
import {
  assertBackupEncryptionReadyForProduction,
  deserializeBackupData,
  serializeBackupData,
} from "./backup-security";
import { decryptRecordFields, encryptRecordFields, RAW_TABLE_PII_COLUMNS } from "./pii-security";
import {
  buildRegionalCustomerListDetailState,
  getDefaultRegionalCustomerListColumnConfig,
  type RegionalCustomerListColumnConfig,
  decodeRegionalCustomerListContent,
  encodeRegionalCustomerListContent,
  normalizeRegionalCustomerListColumnConfig,
  getRegionalCustomerListDetailColumns,
  REGIONAL_CUSTOMER_LIST_TIERS,
  isRegionalCustomerListTier,
  summarizeRegionalCustomerListDetailState,
} from "@shared/regional-customer-list";

const INTENDED_PERMISSION_ADMIN_ROLES = ["\uB300\uD45C\uC774\uC0AC", "\uCD1D\uAD04\uC774\uC0AC", "\uAC1C\uBC1C\uC790"];
const EXECUTIVE_DEPARTMENTS = new Set(["\uACBD\uC601\uC9C4"]);
const USER_PERMISSION_FIELDS = new Set(["role"]);
const USER_SELF_EDIT_FIELDS = new Set(["password", "email", "phone"]);

const PERMISSION_ADMIN_ROLES = ["대표", "이사", "대표이사", "총괄이사", "개발자"];
const DEVELOPER_ROLES = new Set(["개발자"]);
const MANAGER_POSITIONS = new Set(["매니저"]);
const COUNSELOR_POSITIONS = new Set(["상담원"]);
const ADMIN_ONLY_PAGE_KEYS = new Set(["system_settings", "backup"]);
const DEPOSIT_ACTION_ALLOWED_DEPARTMENTS = new Set(["경영진", "경영지원팀", "개발팀", "연구개발팀"]);
const REGIONAL_CUSTOMER_LIST_ALLOWED_DEPARTMENTS = new Set(["타지역팀"]);
const LOCAL_ADMIN_USER_ID = "__local_admin__";
const localAdminUser = {
  id: LOCAL_ADMIN_USER_ID,
  loginId: "admin",
  name: "관리자",
  email: null,
  phone: null,
  role: "개발자",
  department: "개발팀",
  workStatus: "재직중",
  isActive: true,
  lastLoginAt: null,
  lastPasswordChangeAt: null,
  createdAt: new Date(0),
};

function serializeKoreanDbTimestamp(value: unknown): unknown {
  if (!value) return value;

  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return value;
    const pad = (part: number) => String(part).padStart(2, "0");
    return [
      value.getUTCFullYear(),
      pad(value.getUTCMonth() + 1),
      pad(value.getUTCDate()),
    ].join("-") + `T${pad(value.getUTCHours())}:${pad(value.getUTCMinutes())}:${pad(value.getUTCSeconds())}+09:00`;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed) return value;
    if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return value;
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?Z$/i.test(trimmed)) {
      return trimmed.replace(" ", "T").replace(/Z$/i, "+09:00");
    }
    if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?$/.test(trimmed)) {
      return `${trimmed.replace(" ", "T")}+09:00`;
    }
  }

  return value;
}

function serializeCustomerTimeFields<T extends Record<string, any>>(row: T): T {
  return {
    ...row,
    createdAt: serializeKoreanDbTimestamp(row.createdAt),
    updatedAt: serializeKoreanDbTimestamp(row.updatedAt),
    lastCounselingCreatedAt: serializeKoreanDbTimestamp(row.lastCounselingCreatedAt),
    companyConvertedAt: serializeKoreanDbTimestamp(row.companyConvertedAt),
  };
}

function isLocalAdminLogin(loginId: unknown, password: unknown): boolean {
  return !hasDatabaseConfig && String(loginId || "") === "admin" && String(password || "") === "a1234";
}

function getLocalAdminUserBySession(userId: unknown) {
  return !hasDatabaseConfig && userId === LOCAL_ADMIN_USER_ID ? localAdminUser : null;
}

async function ensureDeletedContractDepositsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deleted_contract_deposits (
      contract_id varchar PRIMARY KEY REFERENCES contracts(id) ON DELETE CASCADE,
      deleted_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function getDeletedContractDepositIds(): Promise<Set<string>> {
  await ensureDeletedContractDepositsTable();
  const result = await pool.query(`SELECT contract_id FROM deleted_contract_deposits`);
  return new Set(
    result.rows
      .map((row) => String(row.contract_id || "").trim())
      .filter(Boolean),
  );
}

async function markContractDepositDeleted(contractId: string | null | undefined) {
  const normalized = String(contractId || "").trim();
  if (!normalized) return;
  await ensureDeletedContractDepositsTable();
  await pool.query(
    `
      INSERT INTO deleted_contract_deposits (contract_id, deleted_at)
      VALUES ($1, now())
      ON CONFLICT (contract_id)
      DO UPDATE SET deleted_at = now()
    `,
    [normalized],
  );
}

async function unmarkContractDepositDeleted(contractId: string | null | undefined) {
  const normalized = String(contractId || "").trim();
  if (!normalized) return;
  await ensureDeletedContractDepositsTable();
  await pool.query(`DELETE FROM deleted_contract_deposits WHERE contract_id = $1`, [normalized]);
}

function addCalendarDays(date: Date, days: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + days);
  return next;
}

function toDateOnlyAtNoon(value: Date): Date {
  return new Date(value.getFullYear(), value.getMonth(), value.getDate(), 12, 0, 0, 0);
}

function getRenewalDueDateForContract(
  contractDateValue: Date | string | number | null | undefined,
  dueOffsetDaysValue: unknown,
) {
  const contractDate = normalizeToKoreanContractDate(contractDateValue);
  if (!contractDate) return null;
  const baseDate = toDateOnlyAtNoon(contractDate);
  const dueOffsetDays = Math.max(0, Math.round(Number(dueOffsetDaysValue) || 0));
  return toDateOnlyAtNoon(addCalendarDays(baseDate, dueOffsetDays));
}

function normalizeOptionalContractDateField(value: unknown): Date | null | undefined {
  if (value === undefined) return undefined;
  if (value === null || value === "") return null;
  const normalizedDate = normalizeToKoreanContractDate(value as Date | string | number);
  if (normalizedDate) return normalizedDate;
  if (typeof value === "string" || typeof value === "number" || value instanceof Date) {
    const parsedDate = new Date(value);
    if (!Number.isNaN(parsedDate.getTime())) return parsedDate;
  }
  return undefined;
}

function getRenewalDurationDays(contract: {
  days?: unknown;
  productDetailsJson?: string | null;
}) {
  const itemDays = parseContractProductDetailsForWorkCost(contract.productDetailsJson)
    .map((item) => Math.max(0, Math.round(Number(item.days) || 0)));
  const contractDays = Math.max(0, Math.round(Number(contract.days) || 0));
  return Math.max(0, contractDays, ...itemDays);
}

const RENEWAL_SLOT_CATEGORY_KEY = "\uC2AC\uB86F\uC0C1\uD488";

function normalizeRenewalProductLookupKey(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function getRenewalProductByName(allProducts: Array<{ name?: string | null; category?: string | null }>) {
  return new Map(
    allProducts
      .map((product) => [normalizeRenewalProductLookupKey(product.name), product] as const)
      .filter(([name]) => !!name),
  );
}

function isSlotRenewalProduct(
  productName: unknown,
  productByName: Map<string, { name?: string | null; category?: string | null }>,
) {
  const product = productByName.get(normalizeRenewalProductLookupKey(productName));
  return normalizeRenewalProductLookupKey(product?.category) === normalizeRenewalProductLookupKey(RENEWAL_SLOT_CATEGORY_KEY);
}

function getRenewalDueOffsetDays(
  contract: { days?: unknown; products?: string | null; productDetailsJson?: string | null },
  allProducts: Array<{ name?: string | null; category?: string | null }>,
) {
  const productByName = getRenewalProductByName(allProducts);
  const itemRows = parseContractProductDetailsForWorkCost(contract.productDetailsJson)
    .map((item) => ({
      productName: item.productName,
      days: Math.max(0, Math.round(Number(item.days) || 0)),
    }));
  const contractDays = Math.max(0, Math.round(Number(contract.days) || 0));
  const rows = itemRows.length > 0
    ? itemRows
    : String(contract.products || "")
      .split(",")
      .map((productName) => ({ productName: normalizeText(productName), days: contractDays }))
      .filter((item) => item.productName);
  if (rows.length === 0) return contractDays;
  return Math.max(
    0,
    ...rows.map((item) => item.days + (isSlotRenewalProduct(item.productName, productByName) ? 1 : 0)),
  );
}

function resolveRenewalSchedulePayload<T extends Record<string, any>>(
  contract: T,
  allProducts: Array<{ name?: string | null; category?: string | null }>,
) {
  if (contract.contractType === CONTRACT_TYPE_REFUND) return contract;
  const durationDays = getRenewalDurationDays(contract);
  const dueOffsetDays = getRenewalDueOffsetDays(contract, allProducts);
  const next: Record<string, any> = { ...contract };
  if (!Object.prototype.hasOwnProperty.call(next, "renewalDueDate")) {
    const dueDate = getRenewalDueDateForContract(next.contractDate, dueOffsetDays);
    if (dueDate) next.renewalDueDate = dueDate;
  }
  if (durationDays <= 1) {
    next.renewalAlertDisabled = true;
  }
  return next as T;
}

let cachedTimezone = "Asia/Seoul";
let timezoneCacheTime = 0;
async function getSystemTimezone(): Promise<string> {
  const now = Date.now();
  if (now - timezoneCacheTime > 60000) {
    try {
      const setting = await storage.getSystemSetting("system_timezone");
      if (setting) cachedTimezone = setting.settingValue || "Asia/Seoul";
      timezoneCacheTime = now;
    } catch {}
  }
  return cachedTimezone;
}

function formatServerDate(date: Date, timezone: string): string {
  return date.toLocaleDateString("ko-KR", { timeZone: timezone });
}

function hasHangulText(value: string): boolean {
  return /[가-힣]/.test(value);
}

function normalizeCustomerFileName(value: string | null | undefined): string {
  const raw = String(value ?? "").trim().replace(/[\\\/]+/g, "_");
  if (!raw) return "download";

  try {
    const repaired = Buffer.from(raw, "latin1").toString("utf8").trim().replace(/[\\\/]+/g, "_");
    if (repaired && hasHangulText(repaired) && !hasHangulText(raw)) {
      return repaired;
    }
  } catch {}

  return raw;
}

function toAsciiDownloadFileName(value: string): string {
  const normalized = value
    .normalize("NFKD")
    .replace(/[^\x20-\x7E]/g, "_")
    .replace(/["\\]/g, "_")
    .trim();

  return normalized || "download";
}

async function ensureCustomerDetailTables() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_counselings (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      counseling_date timestamp NOT NULL,
      content text NOT NULL,
      created_by text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_change_histories (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      change_type text NOT NULL DEFAULT 'update',
      changed_fields text,
      before_data text,
      after_data text,
      created_by text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS customer_files (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      customer_id varchar NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
      file_name text NOT NULL,
      original_file_name text,
      mime_type text,
      size_bytes integer NOT NULL DEFAULT 0,
      file_data text NOT NULL,
      uploaded_by text,
      note text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);

  await pool.query(`
    ALTER TABLE customer_files
    ADD COLUMN IF NOT EXISTS original_file_name text,
    ADD COLUMN IF NOT EXISTS note text
  `);
}

async function ensureDealCustomerDbColumns() {
  await pool.query(`
    ALTER TABLE deals
    ADD COLUMN IF NOT EXISTS inbound_date timestamp,
    ADD COLUMN IF NOT EXISTS contract_start_date timestamp,
    ADD COLUMN IF NOT EXISTS contract_end_date timestamp,
    ADD COLUMN IF NOT EXISTS churn_date timestamp,
    ADD COLUMN IF NOT EXISTS renewal_due_date timestamp,
    ADD COLUMN IF NOT EXISTS contract_status text,
    ADD COLUMN IF NOT EXISTS phone text,
    ADD COLUMN IF NOT EXISTS email text,
    ADD COLUMN IF NOT EXISTS billing_account_number text,
    ADD COLUMN IF NOT EXISTS company_name text,
    ADD COLUMN IF NOT EXISTS industry text,
    ADD COLUMN IF NOT EXISTS telecom_provider text,
    ADD COLUMN IF NOT EXISTS customer_disposition text,
    ADD COLUMN IF NOT EXISTS customer_type_detail text,
    ADD COLUMN IF NOT EXISTS first_progress_status text,
    ADD COLUMN IF NOT EXISTS second_progress_status text,
    ADD COLUMN IF NOT EXISTS additional_progress_status text,
    ADD COLUMN IF NOT EXISTS acquisition_channel text,
    ADD COLUMN IF NOT EXISTS cancellation_reason text,
    ADD COLUMN IF NOT EXISTS salesperson text,
    ADD COLUMN IF NOT EXISTS pre_churn_stage text,
    ADD COLUMN IF NOT EXISTS line_count integer DEFAULT 1,
    ADD COLUMN IF NOT EXISTS cancelled_line_count integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS product_id varchar
  `);
}

async function ensureRegionalUnpaidTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regional_unpaid_uploads (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      columns_json text NOT NULL,
      rows_json text NOT NULL,
      imported_count integer NOT NULL DEFAULT 0,
      excluded_count integer NOT NULL DEFAULT 0,
      uploaded_by text,
      created_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function ensureRegionalUnpaidStorageReady() {
  await ensureRegionalUnpaidTable();
}

async function ensureRegionalManagementFeeTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regional_management_fees (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      fee_date timestamp NOT NULL,
      amount integer NOT NULL DEFAULT 0,
      product_name text NOT NULL,
      created_by text,
      updated_by text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function ensureRegionalCustomerListTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS regional_customer_lists (
      id varchar PRIMARY KEY DEFAULT gen_random_uuid(),
      tier text NOT NULL,
      customer_name text NOT NULL,
      registration_count integer NOT NULL DEFAULT 0,
      same_customer text,
      exposure_notice boolean NOT NULL DEFAULT false,
      blog_review boolean NOT NULL DEFAULT false,
      cs_timeline text,
      sort_order integer NOT NULL DEFAULT 0,
      created_by text,
      updated_by text,
      created_at timestamp NOT NULL DEFAULT now(),
      updated_at timestamp NOT NULL DEFAULT now()
    )
  `);
}

async function ensureProductColumns() {
  await pool.query(`
    ALTER TABLE products
    ADD COLUMN IF NOT EXISTS notes text
  `);
}

async function ensureCustomerKeepColumns() {
  await pool.query(`
    ALTER TABLE customers
    ADD COLUMN IF NOT EXISTS keep_balance_adjustment integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS lifecycle_stage text NOT NULL DEFAULT 'customer',
    ADD COLUMN IF NOT EXISTS created_by_name text,
    ADD COLUMN IF NOT EXISTS created_by_user_id varchar
  `);
}

async function ensureCustomerLifecycleSeedData() {
  await pool.query(`
    UPDATE customers
    SET lifecycle_stage = 'customer'
    WHERE lifecycle_stage IS NULL
       OR lifecycle_stage = ''
       OR lifecycle_stage NOT IN ('lead', 'customer')
  `);

  await pool.query(`
    UPDATE customers
    SET customer_type = '계약완료'
    WHERE lifecycle_stage = 'customer'
      AND (customer_type IS NULL OR customer_type = '' OR customer_type = '계약')
  `);

  await pool.query(
    `
      INSERT INTO customers (
        name, status, customer_type, lifecycle_stage, manager_name, created_at
      )
      SELECT $1, 'active', '가망', 'lead', $2, now()
      WHERE NOT EXISTS (
        SELECT 1
        FROM customers
        WHERE lifecycle_stage = 'lead'
          AND name = $1
          AND manager_name = $2
      )
    `,
    ["테스트", "김상만"],
  );
}

async function ensureDepartmentNameSpacing() {
  const legacyMarketingSalesDepartment = `마케팅 ${"영업팀"}`;
  const legacyMarketingPlanningDepartment = `마케팅 ${"기획팀"}`;
  await db
    .update(users)
    .set({ department: "마케팅영업팀" })
    .where(eq(users.department, legacyMarketingSalesDepartment));
  await db
    .update(users)
    .set({ department: "마케팅기획팀" })
    .where(eq(users.department, legacyMarketingPlanningDepartment));
}

async function ensureContractColumns() {
  await pool.query(`
    ALTER TABLE contracts
    ADD COLUMN IF NOT EXISTS product_details_json text,
    ADD COLUMN IF NOT EXISTS deposit_bank text,
    ADD COLUMN IF NOT EXISTS renewal_due_date timestamp,
    ADD COLUMN IF NOT EXISTS renewal_alert_disabled boolean NOT NULL DEFAULT false,
    ADD COLUMN IF NOT EXISTS contract_status text,
    ADD COLUMN IF NOT EXISTS withdrawn_at timestamp,
    ADD COLUMN IF NOT EXISTS withdrawn_by text,
    ADD COLUMN IF NOT EXISTS contract_type text,
    ADD COLUMN IF NOT EXISTS source_contract_id varchar,
    ADD COLUMN IF NOT EXISTS source_item_id text
  `);
  await backfillContractRenewalSchedule();
}

async function backfillContractRenewalSchedule() {
  const existing = await pool.query<{ missing_count: string }>(
    `
      SELECT COUNT(*) AS missing_count
      FROM contracts
      WHERE renewal_due_date IS NULL
        AND COALESCE(contract_type, '') <> $1
        AND contract_date IS NOT NULL
    `,
    [CONTRACT_TYPE_REFUND],
  );
  const missingCount = Number(existing.rows[0]?.missing_count || 0);
  if (missingCount === 0) return { missingCount, updatedCount: 0 };

  const [productsResult, contractsResult] = await Promise.all([
    pool.query<{ name: string | null; category: string | null }>(`SELECT name, category FROM products`),
    pool.query<{
      id: string;
      contract_date: Date | string | null;
      products: string | null;
      days: number | null;
      product_details_json: string | null;
      contract_type: string | null;
    }>(
      `
        SELECT id, contract_date, products, days, product_details_json, contract_type
        FROM contracts
        WHERE renewal_due_date IS NULL
          AND COALESCE(contract_type, '') <> $1
          AND contract_date IS NOT NULL
      `,
      [CONTRACT_TYPE_REFUND],
    ),
  ]);

  let updatedCount = 0;
  for (const row of contractsResult.rows) {
    const contract = {
      contractDate: row.contract_date,
      products: row.products,
      days: row.days,
      productDetailsJson: row.product_details_json,
      contractType: row.contract_type,
    };
    const dueOffsetDays = getRenewalDueOffsetDays(contract, productsResult.rows);
    const dueDate = getRenewalDueDateForContract(contract.contractDate, dueOffsetDays);
    if (!dueDate) continue;

    const durationDays = getRenewalDurationDays(contract);
    const updated = await pool.query(
      `
        UPDATE contracts
        SET renewal_due_date = $2,
            renewal_alert_disabled = CASE WHEN $3 THEN true ELSE COALESCE(renewal_alert_disabled, false) END
        WHERE id = $1
          AND renewal_due_date IS NULL
      `,
      [row.id, dueDate, durationDays <= 1],
    );
    updatedCount += updated.rowCount || 0;
  }
  return { missingCount, updatedCount };
}

async function ensureDepositRefundMatchesTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS deposit_refund_matches (
      deposit_id varchar NOT NULL REFERENCES deposits(id) ON DELETE CASCADE,
      refund_id varchar NOT NULL REFERENCES refunds(id) ON DELETE CASCADE,
      created_at timestamp NOT NULL DEFAULT now(),
      PRIMARY KEY (deposit_id, refund_id)
    )
  `);
}

async function getDepositRefundMatchIds(depositId: string): Promise<string[]> {
  await ensureDepositRefundMatchesTable();
  const result = await pool.query<{ refund_id: string }>(
    `SELECT refund_id FROM deposit_refund_matches WHERE deposit_id = $1 ORDER BY created_at ASC`,
    [depositId],
  );
  return result.rows.map((row) => String(row.refund_id || "").trim()).filter(Boolean);
}

async function replaceDepositRefundMatches(depositId: string, refundIds: string[]) {
  await ensureDepositRefundMatchesTable();
  await pool.query(`DELETE FROM deposit_refund_matches WHERE deposit_id = $1`, [depositId]);
  const normalizedRefundIds = Array.from(new Set(refundIds.map((id) => String(id || "").trim()).filter(Boolean)));
  for (const refundId of normalizedRefundIds) {
    await pool.query(
      `INSERT INTO deposit_refund_matches (deposit_id, refund_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`,
      [depositId, refundId],
    );
  }
}

async function hasDepositRefundMatch(refundId: string): Promise<boolean> {
  const normalizedRefundId = String(refundId || "").trim();
  if (!normalizedRefundId) return false;
  await ensureDepositRefundMatchesTable();
  const result = await pool.query<{ matched: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM deposit_refund_matches
        WHERE refund_id = $1
      ) AS matched
    `,
    [normalizedRefundId],
  );
  return Boolean(result.rows[0]?.matched);
}

async function clearDepositRefundMatches(depositId: string) {
  await ensureDepositRefundMatchesTable();
  await pool.query(`DELETE FROM deposit_refund_matches WHERE deposit_id = $1`, [depositId]);
}

async function hasContractDepositMatch(contractId: string): Promise<boolean> {
  const normalizedContractId = String(contractId || "").trim();
  if (!normalizedContractId) return false;
  const result = await pool.query<{ matched: boolean }>(
    `
      SELECT EXISTS (
        SELECT 1
        FROM deposits
        WHERE contract_id = $1
      ) AS matched
    `,
    [normalizedContractId],
  );
  return Boolean(result.rows[0]?.matched);
}

async function getDepositDeletionBlockers(depositId: string) {
  const existing = await storage.getDeposit(depositId);
  if (!existing) {
    return {
      deposit: null,
      refundIds: [] as string[],
      refundContractIds: [] as string[],
    };
  }

  const contractId = String(existing.contractId || "").trim();
  const matchedRefundIds = await getDepositRefundMatchIds(depositId);
  if (!contractId) {
    return {
      deposit: existing,
      refundIds: matchedRefundIds,
      refundContractIds: [] as string[],
    };
  }

  const [refundContracts, refundRows] = await Promise.all([
    storage.getRefundContractsBySource(contractId),
    storage.getRefundsByContract(contractId),
  ]);
  const activeRefundContractIds = refundContracts
    .filter((contract) => !isWithdrawnContract(contract))
    .map((contract) => String(contract.id || "").trim())
    .filter(Boolean);
  const activeRefundIds = Array.from(
    new Set([
      ...matchedRefundIds,
      ...refundRows.map((refund) => String(refund.id || "").trim()).filter(Boolean),
    ]),
  );

  return {
    deposit: existing,
    refundIds: activeRefundIds,
    refundContractIds: activeRefundContractIds,
  };
}

function hasDepositDeletionBlockers(blockers: Awaited<ReturnType<typeof getDepositDeletionBlockers>>): boolean {
  return blockers.refundIds.length > 0 || blockers.refundContractIds.length > 0;
}

function sendDepositDeletionBlocked(res: Response, blockers: Awaited<ReturnType<typeof getDepositDeletionBlockers>>) {
  return res.status(409).json({
    error: "환불 처리된 계약의 입금확인은 삭제할 수 없습니다. 환불 철회 후 입금확인을 삭제해주세요.",
    refundIds: blockers.refundIds,
    refundContractIds: blockers.refundContractIds,
  });
}

async function ensureFinancialHistoryColumns() {
  await pool.query(`
    ALTER TABLE refunds
    ADD COLUMN IF NOT EXISTS previous_payment_method text,
    ADD COLUMN IF NOT EXISTS item_id text,
    ADD COLUMN IF NOT EXISTS user_identifier text,
    ADD COLUMN IF NOT EXISTS product_name text,
    ADD COLUMN IF NOT EXISTS days integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS add_quantity integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS extend_quantity integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS target_amount integer DEFAULT 0
  `);
  await pool.query(`
    ALTER TABLE keeps
    ADD COLUMN IF NOT EXISTS previous_payment_method text,
    ADD COLUMN IF NOT EXISTS item_id text,
    ADD COLUMN IF NOT EXISTS user_identifier text,
    ADD COLUMN IF NOT EXISTS product_name text,
    ADD COLUMN IF NOT EXISTS days integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS add_quantity integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS extend_quantity integer DEFAULT 0,
    ADD COLUMN IF NOT EXISTS target_amount integer DEFAULT 0
  `);
}

function shouldRunRuntimeSchemaEnsure() {
  const raw = String(process.env.RUNTIME_SCHEMA_ENSURE || "").trim().toLowerCase();
  if (raw === "true" || raw === "1" || raw === "yes" || raw === "on") return true;
  if (raw === "false" || raw === "0" || raw === "no" || raw === "off") return false;
  return (process.env.NODE_ENV || "production") !== "production";
}

async function getCurrentUserName(req: Request): Promise<string | null> {
  if (!req.session.userId) return null;
  const user = await storage.getUser(req.session.userId);
  return user?.name || null;
}

function getRequestIp(req: Request): string {
  const forwarded = req.headers["x-forwarded-for"];
  if (typeof forwarded === "string" && forwarded.trim()) {
    return forwarded.split(",")[0].trim();
  }
  return req.ip || req.socket.remoteAddress || "";
}

function getRawTablePiiColumns(tableName: string): readonly string[] {
  return RAW_TABLE_PII_COLUMNS[tableName as keyof typeof RAW_TABLE_PII_COLUMNS] ?? [];
}

function decryptRawTableRow<T extends Record<string, any>>(tableName: string, row: T): T {
  return decryptRecordFields(row, getRawTablePiiColumns(tableName));
}

function encryptRawTablePayload<T extends Record<string, any>>(tableName: string, payload: T): T {
  return encryptRecordFields(payload, getRawTablePiiColumns(tableName));
}

const CUSTOMER_CHANGE_HISTORY_RESPONSE_PII_FIELDS = ["beforeData", "afterData"];
const CUSTOMER_FILE_RESPONSE_PII_FIELDS = ["fileName", "note"];

async function writeSystemLog(
  req: Request,
  payload: {
    actionType: string;
    action: string;
    details?: string | null;
  },
): Promise<void> {
  try {
    if (!req.session.userId) return;
    const user = await storage.getUser(req.session.userId);
    if (!user) return;
    await storage.createSystemLog({
      userId: user.id,
      loginId: user.loginId,
      userName: user.name,
      action: payload.action,
      actionType: payload.actionType,
      ipAddress: getRequestIp(req),
      userAgent: req.headers["user-agent"] || "",
      details: payload.details || null,
    });
  } catch (error) {
    console.error("System log write error:", error);
  }
}

async function writeEntityAuditLog(
  req: Request,
  entity: "customer" | "product" | "contract",
  operation: "update" | "delete",
  label: string,
  details?: string | null,
): Promise<void> {
  const entityLabel = {
    customer: "고객",
    product: "상품",
    contract: "계약",
  }[entity];
  const operationLabel = operation === "update" ? "수정" : "삭제";

  await writeSystemLog(req, {
    actionType: `${entity}_${operation}`,
    action: `${entityLabel} ${operationLabel}: ${label || "-"}`,
    details: details || null,
  });
}

async function getContractCountByCustomerId(customerId: string): Promise<number> {
  const result = await pool.query(
    `SELECT COUNT(*)::int AS count FROM contracts WHERE customer_id = $1`,
    [customerId],
  );
  return Number(result.rows[0]?.count || 0);
}

async function getContractCountByProductReference(productId: string, productName: string): Promise<number> {
  const result = await pool.query(
    `
      WITH product_names AS (
        SELECT $2::text AS name
        UNION
        SELECT product_name AS name
        FROM product_rate_histories
        WHERE product_id = $1
      )
      SELECT COUNT(*)::int AS count
      FROM contracts
      WHERE EXISTS (
        SELECT 1
        FROM product_names
        WHERE name IS NOT NULL
          AND BTRIM(name) <> ''
          AND POSITION(
            LOWER(BTRIM(name)) IN LOWER(COALESCE(products, '') || ' ' || COALESCE(product_details_json, ''))
          ) > 0
      )
    `,
    [productId, productName],
  );
  return Number(result.rows[0]?.count || 0);
}

function isCustomerLifecycleStage(value: unknown, stage: "lead" | "customer") {
  return String(value || "").trim() === stage;
}

function filterAssignablePageKeys(pageKeys: string[]) {
  return Array.from(new Set(pageKeys.filter((pageKey) => !ADMIN_ONLY_PAGE_KEYS.has(pageKey))));
}

function normalizeLeadCustomerPayload(body: Record<string, any>) {
  if (body.lifecycleStage !== "lead") return body;
  if (!String(body.customerType || "").trim()) {
    body.customerType = "가망";
  }
  const category = String(body.customerCategory || "").trim();
  if (!category || category === "리드") {
    body.customerCategory = "일반고객";
  }
  if (String(body.serviceType || "").trim() === "복합상품") {
    body.serviceType = null;
  }
  return body;
}

function normalizeDuplicateName(value: unknown) {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizeDuplicatePhone(value: unknown) {
  return String(value ?? "").replace(/\D/g, "");
}

const EMPTY_PHONE_PLACEHOLDER = "01000000000";

function isEmptyPhonePlaceholder(value: unknown) {
  return normalizeDuplicatePhone(value) === EMPTY_PHONE_PLACEHOLDER;
}

async function findLeadCustomerDuplicate(
  payload: { name?: unknown; phone?: unknown },
  excludeCustomerId?: string | null,
) {
  const nameKey = normalizeDuplicateName(payload.name);
  const phoneKey = normalizeDuplicatePhone(payload.phone);
  if (!nameKey && !phoneKey) return null;

  const existingCustomers = await storage.getCustomers();
  return existingCustomers.find((customer) => {
    if (excludeCustomerId && String(customer.id) === String(excludeCustomerId)) return false;
    const existingNameKey = normalizeDuplicateName(customer.name);
    const existingPhoneKey = normalizeDuplicatePhone(customer.phone);
    const hasSamePhone =
      !!phoneKey &&
      !isEmptyPhonePlaceholder(phoneKey) &&
      !!existingPhoneKey &&
      !isEmptyPhonePlaceholder(existingPhoneKey) &&
      existingPhoneKey === phoneKey;
    const hasSameName = !!nameKey && !!existingNameKey && existingNameKey === nameKey;
    return hasSamePhone || (!phoneKey && hasSameName) || (hasSameName && !!existingPhoneKey && existingPhoneKey === phoneKey);
  }) || null;
}

function duplicateLeadCustomerMessage(duplicate: { lifecycleStage?: string | null; name?: string | null; phone?: string | null }) {
  const type = isCustomerLifecycleStage(duplicate.lifecycleStage, "lead") ? "리드" : "고객사";
  const phone = String(duplicate.phone || "").trim() || "전화번호 없음";
  return `이미 등록된 ${type}입니다. (${duplicate.name || "이름 없음"} / ${phone})`;
}

async function getSessionUser(req: Request) {
  return req.session.userId ? await storage.getUser(req.session.userId) : null;
}

function normalizeRoleName(role?: string | null) {
  return String(role || "").trim();
}

function isManagerPosition(role?: string | null) {
  return MANAGER_POSITIONS.has(normalizeRoleName(role));
}

function isCounselorPosition(role?: string | null) {
  return COUNSELOR_POSITIONS.has(normalizeRoleName(role));
}

function canViewSensitiveFinancialFields(role?: string | null) {
  return !isManagerPosition(role) && !isCounselorPosition(role);
}

function isOwnManagedRecord(
  currentUser: { id?: string | null; name?: string | null },
  record: { managerId?: string | null; managerName?: string | null },
) {
  const userId = normalizeText(currentUser.id);
  const userName = normalizeText(currentUser.name);
  return (
    (!!userId && normalizeText(record.managerId) === userId) ||
    (!!userName && normalizeText(record.managerName) === userName)
  );
}

function sanitizeFinancialContractRow(row: Record<string, any>, role?: string | null) {
  if (canViewSensitiveFinancialFields(role)) return row;
  const sanitized = { ...row };
  sanitized.workCost = null;
  if (typeof sanitized.productDetailsJson === "string" && sanitized.productDetailsJson.trim()) {
    try {
      const details = JSON.parse(sanitized.productDetailsJson);
      if (Array.isArray(details)) {
        sanitized.productDetailsJson = JSON.stringify(details.map((item) => ({
          ...item,
          workCost: null,
          marginAmount: null,
        })));
      }
    } catch {
      sanitized.productDetailsJson = null;
    }
  }
  return sanitized;
}

async function convertCustomerToCompany(customerId: string, convertedByName?: string | null) {
  const updatePayload: Record<string, unknown> = {
    lifecycleStage: "customer",
    customerType: "계약완료",
  };
  const normalizedConvertedByName = normalizeText(convertedByName);
  if (normalizedConvertedByName) {
    updatePayload.managerName = normalizedConvertedByName;
  }
  return storage.updateCustomer(customerId, {
    ...updatePayload,
  } as any);
}

const BACKUP_MAX_BYTES = 200 * 1024 * 1024;
const BACKUP_ADVISORY_LOCK_KEY = 9020601;
const BACKUP_RETENTION_SETTING_KEY = "backup_retention_count";
const REGIONAL_CUSTOMER_LIST_COLUMN_CONFIG_SETTING_KEY = "regional_customer_list_column_config";
const BACKUP_RETENTION_DEFAULT = 100;
const BACKUP_RETENTION_MIN = 10;
const BACKUP_RETENTION_MAX = 500;
const BACKUP_REQUIRED_TABLE_KEYS = [
  "users",
  "customers",
  "contacts",
  "deals",
  "dealTimelines",
  "regionalCustomerLists",
  "activities",
  "payments",
  "products",
  "contracts",
  "refunds",
  "keeps",
  "deposits",
  "notices",
  "pagePermissions",
  "systemSettings",
  "systemLogs",
] as const;

const updateRegionalManagementFeeSchema = insertRegionalManagementFeeSchema.partial();
const updateRegionalCustomerListSchema = insertRegionalCustomerListSchema.partial();

async function getRegionalCustomerListColumnConfig(): Promise<RegionalCustomerListColumnConfig> {
  try {
    const setting = await storage.getSystemSetting(REGIONAL_CUSTOMER_LIST_COLUMN_CONFIG_SETTING_KEY);
    if (!setting?.settingValue) {
      return getDefaultRegionalCustomerListColumnConfig();
    }
    return normalizeRegionalCustomerListColumnConfig(JSON.parse(setting.settingValue));
  } catch {
    return getDefaultRegionalCustomerListColumnConfig();
  }
}

async function saveRegionalCustomerListColumnConfig(
  rawValue: unknown,
): Promise<RegionalCustomerListColumnConfig> {
  const normalized = normalizeRegionalCustomerListColumnConfig(rawValue);
  await storage.setSystemSetting(
    REGIONAL_CUSTOMER_LIST_COLUMN_CONFIG_SETTING_KEY,
    JSON.stringify(normalized),
  );
  return normalized;
}

function buildRegionalCustomerListResponseItem(
  item: any,
  columnConfig?: RegionalCustomerListColumnConfig,
) {
  const decoded = decodeRegionalCustomerListContent(item.tier, item.csTimeline, {
    exposureNotice: item.exposureNotice,
    blogReview: item.blogReview,
    columnConfig,
  });
  const summary = summarizeRegionalCustomerListDetailState(item.tier, decoded.detailColumns, {
    exposureNotice: item.exposureNotice,
    blogReview: item.blogReview,
    columnConfig,
  });

  return {
    ...item,
    exposureNotice: summary.exposureNotice,
    blogReview: summary.blogReview,
    csTimeline: decoded.timeline,
    detailColumns: summary.detailColumns,
  };
}

function resolveRegionalCustomerListStoredValues(
  tier: string,
  body: Record<string, unknown>,
  columnConfig?: RegionalCustomerListColumnConfig,
  existing?: {
    tier: string;
    csTimeline: string | null;
    exposureNotice: boolean;
    blogReview: boolean;
  },
) {
  const existingDecoded = existing
    ? decodeRegionalCustomerListContent(existing.tier, existing.csTimeline, {
        exposureNotice: existing.exposureNotice,
        blogReview: existing.blogReview,
        columnConfig,
      })
    : {
        detailColumns: buildRegionalCustomerListDetailState(tier, { columnConfig }),
        timeline: null as string | null,
      };

  let detailColumns = summarizeRegionalCustomerListDetailState(
    tier,
    body.detailColumns ?? existingDecoded.detailColumns,
    {
      exposureNotice: existing?.exposureNotice,
      blogReview: existing?.blogReview,
      columnConfig,
    },
  ).detailColumns;

  if (body.exposureNotice !== undefined) {
    const nextValue = Boolean(body.exposureNotice);
    for (const column of getRegionalCustomerListDetailColumns(tier, columnConfig)) {
      if (column.category === "exposure") {
        detailColumns[column.key] = nextValue;
      }
    }
  }

  if (body.blogReview !== undefined) {
    const nextValue = Boolean(body.blogReview);
    for (const column of getRegionalCustomerListDetailColumns(tier, columnConfig)) {
      if (column.category === "blog") {
        detailColumns[column.key] = nextValue;
      }
    }
  }

  const summary = summarizeRegionalCustomerListDetailState(tier, detailColumns, {
    exposureNotice: existing?.exposureNotice,
    blogReview: existing?.blogReview,
    columnConfig,
  });
  const timelineText =
    body.csTimeline === undefined
      ? existingDecoded.timeline
      : String(body.csTimeline || "").trim() || null;

  return {
    detailColumns: summary.detailColumns,
    exposureNotice: summary.exposureNotice,
    blogReview: summary.blogReview,
    csTimeline: encodeRegionalCustomerListContent(tier, summary.detailColumns, timelineText, {
      ...summary,
      columnConfig,
    }),
  };
}

let cachedBackupRetentionCount = BACKUP_RETENTION_DEFAULT;
let backupRetentionCacheTime = 0;

function clampBackupRetentionCount(value: number): number {
  if (!Number.isFinite(value)) return BACKUP_RETENTION_DEFAULT;
  if (value < BACKUP_RETENTION_MIN) return BACKUP_RETENTION_MIN;
  if (value > BACKUP_RETENTION_MAX) return BACKUP_RETENTION_MAX;
  return Math.floor(value);
}

async function getBackupRetentionCount(): Promise<number> {
  const now = Date.now();
  if (now - backupRetentionCacheTime > 60000) {
    try {
      const setting = await storage.getSystemSetting(BACKUP_RETENTION_SETTING_KEY);
      const parsed = parseInt(setting?.settingValue || "", 10);
      cachedBackupRetentionCount = clampBackupRetentionCount(parsed);
    } catch {
      cachedBackupRetentionCount = BACKUP_RETENTION_DEFAULT;
    } finally {
      backupRetentionCacheTime = now;
    }
  }
  return cachedBackupRetentionCount;
}

async function pruneOldBackups(retentionCount: number): Promise<number> {
  const normalizedRetentionCount = clampBackupRetentionCount(retentionCount);
  const backups = await storage.getBackups();
  if (backups.length <= normalizedRetentionCount) return 0;

  const targets = backups.slice(normalizedRetentionCount);
  for (const backup of targets) {
    await storage.deleteBackup(backup.id);
  }
  return targets.length;
}

function validateBackupTablesShape(tables: unknown): { isValid: boolean; missing: string[]; invalid: string[] } {
  if (!tables || typeof tables !== "object") {
    return {
      isValid: false,
      missing: [...BACKUP_REQUIRED_TABLE_KEYS],
      invalid: [],
    };
  }

  const source = tables as Record<string, unknown>;
  const missing = BACKUP_REQUIRED_TABLE_KEYS.filter((key) => !(key in source));
  const invalid = BACKUP_REQUIRED_TABLE_KEYS.filter((key) => key in source && !Array.isArray(source[key]));
  return {
    isValid: missing.length === 0 && invalid.length === 0,
    missing,
    invalid,
  };
}

async function tryAcquireBackupOperationLock(): Promise<(() => Promise<void>) | null> {
  const client: PoolClient = await pool.connect();
  try {
    const lockResult = await client.query<{ acquired: boolean }>(
      "SELECT pg_try_advisory_lock($1) AS acquired",
      [BACKUP_ADVISORY_LOCK_KEY],
    );
    const acquired = lockResult.rows[0]?.acquired === true;
    if (!acquired) {
      client.release();
      return null;
    }

    let released = false;
    return async () => {
      if (released) return;
      released = true;
      try {
        await client.query("SELECT pg_advisory_unlock($1)", [BACKUP_ADVISORY_LOCK_KEY]);
      } finally {
        client.release();
      }
    };
  } catch (error) {
    client.release();
    throw error;
  }
}

function computeBackupHashFromTables(tables: Record<string, unknown>): string {
  const tableJson = JSON.stringify(tables);
  return crypto.createHash("sha256").update(tableJson).digest("hex");
}

function buildBackupPayload(tables: Record<string, unknown>) {
  const hash = computeBackupHashFromTables(tables);
  return {
    version: "1.1",
    createdAt: new Date().toISOString(),
    integrity: {
      algorithm: "sha256",
      contentHash: hash,
    },
    tables,
  };
}

function verifyBackupPayloadIntegrity(backupPayload: any): { isValid: boolean; hash: string; reason: string } {
  if (!backupPayload || typeof backupPayload !== "object") {
    return { isValid: false, hash: "", reason: "invalid_payload" };
  }
  if (!backupPayload.tables || typeof backupPayload.tables !== "object") {
    return { isValid: false, hash: "", reason: "missing_tables" };
  }
  const computedHash = computeBackupHashFromTables(backupPayload.tables as Record<string, unknown>);
  const declaredHash = String(backupPayload?.integrity?.contentHash || "").trim();
  if (!declaredHash) {
    return { isValid: true, hash: computedHash, reason: "missing_integrity_legacy" };
  }
  if (declaredHash !== computedHash) {
    return { isValid: false, hash: computedHash, reason: "hash_mismatch" };
  }
  return { isValid: true, hash: computedHash, reason: "verified" };
}

const DEAL_NOTE_PREFIX = "[CS메모]";
const DEAL_CANCELLATION_REASON_PREFIX = "[해지사유]";

function extractDealNoteFromTimelineContent(content: string): string | null {
  const normalized = content.trim();
  if (!normalized) return null;

  if (normalized.startsWith(DEAL_NOTE_PREFIX)) {
    const stripped = normalized.slice(DEAL_NOTE_PREFIX.length).trim();
    return stripped || null;
  }

  if (
    normalized.startsWith("[인입]") ||
    normalized.startsWith("[개통]") ||
    normalized.startsWith("[해지]") ||
    normalized.startsWith("[부분해지]") ||
    normalized.startsWith(DEAL_CANCELLATION_REASON_PREFIX) ||
    /^\[\?+\]/.test(normalized)
  ) {
    return null;
  }

  return normalized;
}

function extractDealCancellationReasonFromTimelineContent(content: string): string | null {
  const normalized = content.trim();
  if (!normalized) return null;
  const match = normalized.match(/^\[(?:해지사유|\?+)\]\s*(?:(?:\d{4}\.\d{2}\.\d{2})\s+)?([\s\S]+)$/);
  return match?.[1]?.trim() || null;
}

async function syncDealNotesFromLatestTimeline(dealId: string) {
  const timelines = await storage.getDealTimelines(dealId);
  const latestNoteContent =
    timelines
      .map((timeline) => extractDealNoteFromTimelineContent(String(timeline.content || "")))
      .find((content): content is string => Boolean(content)) || "";
  await storage.updateDeal(dealId, { notes: latestNoteContent });
}

async function createDealTimelineAndSync(data: {
  dealId: string;
  content: string;
  authorId?: string | null;
  authorName?: string | null;
}) {
  const timeline = await storage.createDealTimeline({
    dealId: data.dealId,
    content: data.content,
    authorId: data.authorId ?? null,
    authorName: data.authorName ?? null,
  });
  await syncDealNotesFromLatestTimeline(data.dealId);
  return timeline;
}

async function ensureDealNoteTimeline(data: {
  dealId: string;
  note: string;
  authorId?: string | null;
  authorName?: string | null;
}) {
  const normalizedNote = data.note.trim();
  if (!normalizedNote) return null;
  const timelines = await storage.getDealTimelines(data.dealId);
  const existing = timelines.find((timeline) => {
    const extracted = extractDealNoteFromTimelineContent(String(timeline.content || ""));
    return extracted === normalizedNote;
  });
  if (existing) {
    return existing;
  }
  return createDealTimelineAndSync({
    dealId: data.dealId,
    content: `${DEAL_NOTE_PREFIX} ${normalizedNote}`,
    authorId: data.authorId ?? null,
    authorName: data.authorName ?? null,
  });
}

async function ensureDealCancellationReasonTimeline(data: {
  dealId: string;
  reason: string;
  reasonDate?: Date | string | null;
  authorId?: string | null;
  authorName?: string | null;
}) {
  const normalizedReason = data.reason.trim();
  if (!normalizedReason) return null;
  const timelines = await storage.getDealTimelines(data.dealId);
  const existing = timelines.find((timeline) => {
    const extracted = extractDealCancellationReasonFromTimelineContent(String(timeline.content || ""));
    return extracted === normalizedReason;
  });
  if (existing) {
    return existing;
  }

  const tz = await getSystemTimezone();
  const reasonDate = data.reasonDate ? formatServerDate(new Date(data.reasonDate), tz) : formatServerDate(new Date(), tz);
  return createDealTimelineAndSync({
    dealId: data.dealId,
    content: `${DEAL_CANCELLATION_REASON_PREFIX} ${reasonDate} ${normalizedReason}`,
    authorId: data.authorId ?? null,
    authorName: data.authorName ?? null,
  });
}

async function autoLoginDev(req: Request, _res: Response, next: NextFunction) {
  if (process.env.NODE_ENV !== "production" && !req.session.userId) {
    if (req.cookies?.["crm_logged_out"] === "1") {
      return next();
    }
    const preferredLoginId = String(process.env.DEV_AUTO_LOGIN_ID || "").trim();
    const usersForAutoLogin = await storage.getUsers();
    const preferredUser = preferredLoginId
      ? usersForAutoLogin.find((user) => user.loginId === preferredLoginId && user.isActive)
      : undefined;
    const fallbackUser =
      preferredUser ||
      usersForAutoLogin.find((user) => user.isActive && PERMISSION_ADMIN_ROLES.includes(user.role || "")) ||
      usersForAutoLogin.find((user) => user.isActive);
    if (fallbackUser) {
      req.session.userId = fallbackUser.id;
    }
  }
  next();
}

function requireAuth(req: Request, res: Response, next: NextFunction) {
  if (!req.session.userId) {
    return res.status(401).json({ error: "로그인이 필요합니다." });
  }
  next();
}

function toSingleString(value: string | string[] | undefined | null): string {
  if (Array.isArray(value)) {
    return value[0] ?? "";
  }
  return value ?? "";
}

function toPositiveInt(value: string | string[] | undefined | null, fallback: number): number {
  const parsed = parseInt(toSingleString(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function parseKoreanRangeStart(value: string | string[] | undefined | null): Date | undefined {
  const normalized = toSingleString(value).trim();
  if (!normalized) return undefined;
  const key = getKoreanDateKey(normalized);
  if (!key) return undefined;
  const date = new Date(`${key}T00:00:00+09:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function parseKoreanRangeEnd(value: string | string[] | undefined | null): Date | undefined {
  const normalized = toSingleString(value).trim();
  if (!normalized) return undefined;
  const key = getKoreanDateKey(normalized);
  if (!key) return undefined;
  const date = new Date(`${key}T23:59:59.999+09:00`);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function normalizeFlagText(value: string | null | undefined): string {
  return (value ?? "").toString().trim().toLowerCase();
}

function parseInvoiceIssuedFlag(value: string | null | undefined): boolean | null {
  const normalized = normalizeFlagText(value);
  if (!normalized) return null;

  if (["true", "1", "y", "yes", "o", "발행", "발급", "포함", "부가세포함"].includes(normalized)) return true;
  if (["false", "0", "n", "no", "x", "미발행", "미발급", "미포함", "별도", "부가세별도", "면세"].includes(normalized)) return false;
  return null;
}

type DepositMatchProductItemLike = {
  id?: string | null;
  productName?: string;
  userIdentifier?: string | null;
  supplyAmount?: number | null;
  grossSupplyAmount?: number | null;
  unitPrice?: number;
  vatType?: string | null;
  addQuantity?: number;
  extendQuantity?: number;
  quantity?: number;
};

type DepositMatchFinancialEntryLike = {
  amount?: number | null;
  targetAmount?: number | null;
  itemId?: string | null;
  userIdentifier?: string | null;
  productName?: string | null;
};

function normalizeDepositMatchVatType(value: string | null | undefined): "포함" | "미포함" {
  const normalized = String(value || "").replace(/\s+/g, "");
  if (["부가세포함", "포함"].includes(normalized)) return "포함";
  return "미포함";
}

function getDepositMatchItemQuantity(item: DepositMatchProductItemLike): number {
  const quantity = Math.max(0, Number(item.quantity) || 0);
  if (quantity > 0) return quantity;
  const addQuantity = Math.max(0, Number(item.addQuantity) || 0);
  const extendQuantity = Math.max(0, Number(item.extendQuantity) || 0);
  return Math.max(1, addQuantity + extendQuantity || 1);
}

function normalizeDepositMatchText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeDepositMatchCompactText(value: unknown): string {
  return normalizeDepositMatchText(value).replace(/\s+/g, "");
}

function parseDepositMatchProductItems(rawValue: unknown): DepositMatchProductItemLike[] {
  const rawJson = String(rawValue || "").trim();
  if (!rawJson) return [];
  try {
    const parsed = JSON.parse(rawJson);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter((item): item is DepositMatchProductItemLike => !!item && typeof item === "object");
  } catch {
    return [];
  }
}

function getDepositMatchItemBaseAmount(item: DepositMatchProductItemLike): number {
  const storedSupplyAmount = Math.max(0, Number(item.supplyAmount) || 0);
  if (storedSupplyAmount > 0) return storedSupplyAmount;
  return Math.max(0, Number(item.unitPrice) || 0) * getDepositMatchItemQuantity(item);
}

function getDepositMatchItemGrossAmount(item: DepositMatchProductItemLike, fallbackIncluded = false): number {
  const storedGrossAmount = Math.max(0, Number(item.grossSupplyAmount) || 0);
  if (storedGrossAmount > 0) return storedGrossAmount;
  const baseAmount = getDepositMatchItemBaseAmount(item);
  const vatType = normalizeDepositMatchVatType(item.vatType ?? (fallbackIncluded ? "포함" : "미포함"));
  return vatType === "포함" ? baseAmount + Math.round(baseAmount * 0.1) : baseAmount;
}

function findDepositMatchItem(
  contract: { productDetailsJson?: string | null },
  entry: DepositMatchFinancialEntryLike,
): DepositMatchProductItemLike | null {
  const items = parseDepositMatchProductItems(contract.productDetailsJson);
  const normalizedItemId = normalizeDepositMatchText(entry.itemId);
  if (normalizedItemId) {
    const exactItem = items.find((item) => normalizeDepositMatchText(item.id) === normalizedItemId);
    if (exactItem) return exactItem;
  }

  const normalizedUserIdentifier = normalizeDepositMatchCompactText(entry.userIdentifier);
  const normalizedProductName = normalizeDepositMatchCompactText(entry.productName);
  if (!normalizedUserIdentifier && !normalizedProductName) return null;

  return (
    items.find(
      (item) =>
        (!normalizedUserIdentifier ||
          normalizeDepositMatchCompactText(item.userIdentifier) === normalizedUserIdentifier) &&
        (!normalizedProductName ||
          normalizeDepositMatchCompactText(item.productName) === normalizedProductName),
    ) || null
  );
}

function getDepositMatchRefundAmountWithVat(
  contract:
    | {
        cost?: number | null;
        invoiceIssued?: string | null;
        productDetailsJson?: string | null;
      }
    | null
    | undefined,
  entry: DepositMatchFinancialEntryLike,
): number {
  const amount = Math.max(0, Number(entry.amount) || 0);
  if (amount <= 0) return 0;
  if (!contract) return amount;

  const matchedItem = findDepositMatchItem(contract, entry);
  if (matchedItem) {
    const itemBaseAmount = getDepositMatchItemBaseAmount(matchedItem);
    const itemGrossAmount = getDepositMatchItemGrossAmount(
      matchedItem,
      parseInvoiceIssuedFlag(contract.invoiceIssued) === true,
    );
    const effectiveTargetBase = Math.max(0, Number(entry.targetAmount) || 0) || itemBaseAmount;
    if (effectiveTargetBase > 0 && itemBaseAmount > 0) {
      const scaledGrossTarget = Math.max(
        effectiveTargetBase,
        Math.round((effectiveTargetBase / itemBaseAmount) * itemGrossAmount),
      );
      return Math.max(0, Math.floor((amount / effectiveTargetBase) * scaledGrossTarget + 1e-6));
    }
  }

  const contractBaseAmount = Math.max(0, Number(entry.targetAmount) || 0) || Math.max(0, Number(contract.cost) || 0);
  const contractGrossAmount = Math.max(getDepositMatchContractAmount(contract), contractBaseAmount);
  if (contractBaseAmount > 0) {
    return Math.max(0, Math.floor((amount / contractBaseAmount) * contractGrossAmount + 1e-6));
  }
  return amount;
}

function getDepositMatchContractAmount(contract: {
  cost?: number | null;
  invoiceIssued?: string | null;
  productDetailsJson?: string | null;
}): number {
  const items = parseDepositMatchProductItems(contract.productDetailsJson).filter((item) =>
    String(item.productName || "").trim(),
  );
  if (items.length > 0) {
    const fallbackIncluded = parseInvoiceIssuedFlag(contract.invoiceIssued) === true;
    return items.reduce((sum, item) => sum + getDepositMatchItemGrossAmount(item, fallbackIncluded), 0);
  }

  const baseAmount = Math.max(0, Number(contract.cost) || 0);
  if (parseInvoiceIssuedFlag(contract.invoiceIssued) === true) {
    return baseAmount + Math.round(baseAmount * 0.1);
  }
  return baseAmount;
}

function buildPaymentPayloadFromContract(contract: {
  id: string;
  contractDate: Date;
  customerName: string;
  managerName: string;
  cost: number;
  paymentConfirmed: boolean | null;
  paymentMethod: string | null;
  invoiceIssued: string | null;
  notes: string | null;
  contractStatus?: string | null;
}) {
  const withdrawn = isWithdrawnContract(contract);
  return {
    contractId: contract.id,
    depositDate: contract.contractDate,
    customerName: contract.customerName,
    manager: contract.managerName,
    amount: withdrawn ? 0 : contract.cost,
    depositConfirmed: withdrawn ? false : contract.paymentConfirmed || false,
    paymentMethod: contract.paymentMethod || null,
    invoiceIssued: parseInvoiceIssuedFlag(contract.invoiceIssued) === true,
    notes: contract.notes || null,
  };
}

function vatTypeFromInvoiceIssued(value: string | null | undefined): "부가세별도" | "부가세포함" | null {
  const issued = parseInvoiceIssuedFlag(value);
  if (issued === null) return null;
  return issued ? "부가세포함" : "부가세별도";
}

const PAYMENT_METHOD_BEFORE_DEPOSIT = "입금예정";
const PAYMENT_METHOD_WITHDRAWN = "철회";
const PAYMENT_METHOD_REFUND_REQUEST = "환불요청";
const PAYMENT_METHOD_DEPOSIT_CONFIRMED = "입금완료";
const PAYMENT_METHOD_OTHER = "기타";
const CONTRACT_STATUS_WITHDRAWN = "withdrawn";
const REFUND_STATUS_PENDING = "환불대기";
const REFUND_STATUS_REQUESTED = "환불요청";
const REFUND_STATUS_COMPLETED = "환불완료";
const REFUND_STATUS_OFFSET = "상계처리";
const CONTRACT_TYPE_REFUND = "refund";
const CONTRACT_DEPOSIT_BANK_DEFAULT = "국민은행";
const FINANCIAL_OVERRIDE_PAYMENT_METHODS = new Set<string>();

function isWithdrawnContract(contract: { contractStatus?: string | null } | null | undefined): boolean {
  return String(contract?.contractStatus || "").trim().toLowerCase() === CONTRACT_STATUS_WITHDRAWN;
}

function isTeamLeadOrHigherRole(role?: string | null): boolean {
  return new Set(["팀장", "실장", "이사", "대표", "대표이사", "총괄이사", "개발자"]).has(String(role || "").trim());
}

function normalizeContractPaymentMethod(value: unknown): string {
  const raw = String(value ?? "").trim();
  const normalized = raw.replace(/\s+/g, "");
  const asciiKey = normalized.replace(/[_-]/g, "").toLowerCase();

  if (!normalized) return PAYMENT_METHOD_BEFORE_DEPOSIT;
  if (normalized === PAYMENT_METHOD_WITHDRAWN || ["withdraw", "withdrawn", "cancelled", "canceled"].includes(asciiKey)) {
    return PAYMENT_METHOD_WITHDRAWN;
  }
  if (
    normalized === PAYMENT_METHOD_BEFORE_DEPOSIT ||
    normalized === "입금전" ||
    ["beforedeposit", "pendingdeposit", "beforepayment", "unpaid"].includes(asciiKey)
  ) {
    return PAYMENT_METHOD_BEFORE_DEPOSIT;
  }
  if (
    normalized === PAYMENT_METHOD_REFUND_REQUEST ||
    normalized === "환불" ||
    normalized === "환불처리" ||
    normalized === "환불등록" ||
    ["refund", "refunded", "refundrequest", "refundrequested"].includes(asciiKey)
  ) {
    return PAYMENT_METHOD_REFUND_REQUEST;
  }
  if (
    normalized === "적립금사용" ||
    normalized === "적립금" ||
    normalized === "적립" ||
    ["usekeep", "usecredit", "credituse", "keepuse", "keep", "credit"].includes(asciiKey)
  ) return PAYMENT_METHOD_OTHER;
  if (
    normalized === PAYMENT_METHOD_DEPOSIT_CONFIRMED ||
    normalized === "입금확인" ||
    normalized === "입금완료" ||
    normalized === "국민은행" ||
    normalized === "카드결제" ||
    normalized === "크몽" ||
    ["deposit", "deposited", "banktransfer", "transfer", "confirmed", "kb", "kookmin", "kbstar", "card", "cardpayment", "kmong"].includes(asciiKey)
  ) {
    return PAYMENT_METHOD_DEPOSIT_CONFIRMED;
  }
  if (normalized === "출금완료" || ["withdrawalcomplete", "withdrawncomplete", "payoutcomplete"].includes(asciiKey)) {
    return "출금완료";
  }
  if (normalized === PAYMENT_METHOD_OTHER || normalized === "체크" || ["other", "check", "etc"].includes(asciiKey)) {
    return PAYMENT_METHOD_OTHER;
  }
  return raw;
}

function normalizeContractDepositBank(value: unknown, fallbackPaymentMethod?: unknown): string {
  const raw = String(value ?? "").trim();
  const paymentMethod = String(fallbackPaymentMethod ?? "").trim();
  const normalized = (raw || paymentMethod).replace(/\s+/g, "");
  const asciiKey = normalized.replace(/[_-]/g, "").toLowerCase();

  if (
    normalized === "국민" ||
    normalized === "국민은행" ||
    ["kb", "kookmin", "kbstar"].includes(asciiKey)
  ) {
    return "국민은행";
  }
  if (
    normalized === "카드결제" ||
    normalized === "카드 결제" ||
    ["card", "cardpayment", "creditcard"].includes(asciiKey)
  ) {
    return "카드결제";
  }
  if (
    normalized === "크몽" ||
    ["kmong"].includes(asciiKey)
  ) {
    return "크몽";
  }
  if (normalized === "기타" || asciiKey === "other") {
    return "기타";
  }
  return normalized ? "기타" : CONTRACT_DEPOSIT_BANK_DEFAULT;
}

function shouldAutoMapDepositConfirmation(contract: Pick<Contract, "cost" | "contractType" | "contractStatus" | "paymentMethod" | "paymentConfirmed">): boolean {
  if (isWithdrawnContract(contract)) return false;
  if (String(contract.contractType || "").trim() === CONTRACT_TYPE_REFUND) return false;
  if ((Number(contract.cost) || 0) <= 0) return false;
  return normalizeContractPaymentMethod(contract.paymentMethod) === PAYMENT_METHOD_DEPOSIT_CONFIRMED || contract.paymentConfirmed === true;
}

function buildAutoDepositPayloadFromContract(contract: Contract, confirmedBy: string): InsertDeposit {
  const amount = Math.max(0, Math.round(getDepositMatchContractAmount(contract)));
  return {
    depositDate: contract.contractDate,
    depositorName: contract.customerName || "-",
    depositAmount: amount,
    depositBank: normalizeContractDepositBank(contract.depositBank, contract.paymentMethod),
    notes: contract.notes || null,
    confirmedAmount: amount,
    totalContractAmount: amount,
    contractId: contract.id,
    confirmedBy,
    confirmedAt: new Date(),
  };
}

async function upsertAutoDepositConfirmationFromContract(contract: Contract, confirmedBy = "system") {
  if (!shouldAutoMapDepositConfirmation(contract)) return null;

  const payload = buildAutoDepositPayloadFromContract(contract, confirmedBy);
  const existingDeposit = await storage.getDepositByContractId(contract.id);

  if (existingDeposit) {
    const updated = await storage.updateDeposit(existingDeposit.id, {
      ...payload,
      depositDate: existingDeposit.depositDate || payload.depositDate,
      depositBank: existingDeposit.depositBank || payload.depositBank,
      notes: existingDeposit.notes || payload.notes,
    });
    await unmarkContractDepositDeleted(contract.id);
    return updated;
  }

  const created = await storage.createDeposit({
    ...payload,
    notes: payload.notes || "계약관리 입금완료 자동 매핑",
  });
  await unmarkContractDepositDeleted(contract.id);
  return created;
}

function isMatchableDepositContract(contract: { paymentMethod?: unknown; paymentConfirmed?: unknown }): boolean {
  const normalized = normalizeContractPaymentMethod(contract.paymentMethod);
  return (
    normalized === PAYMENT_METHOD_BEFORE_DEPOSIT ||
    normalized === PAYMENT_METHOD_OTHER
  );
}

function isFinancialOverridePaymentMethod(paymentMethod: unknown): boolean {
  return FINANCIAL_OVERRIDE_PAYMENT_METHODS.has(normalizeContractPaymentMethod(paymentMethod));
}

function normalizeRestorablePaymentMethod(paymentMethod: unknown): string | null {
  const normalized = normalizeContractPaymentMethod(paymentMethod);
  if (!normalized) return null;
  return isFinancialOverridePaymentMethod(normalized) ? null : normalized;
}

function resolveDepositFallbackPaymentMethod(contract: {
  paymentMethod?: string | null;
  paymentConfirmed?: boolean | null;
} | null | undefined): string {
  const stored = normalizeRestorablePaymentMethod(contract?.paymentMethod);
  if (stored) return stored;
  if (contract?.paymentConfirmed) return PAYMENT_METHOD_DEPOSIT_CONFIRMED;
  return PAYMENT_METHOD_BEFORE_DEPOSIT;
}

function normalizeRefundStatus(value: unknown): string | null {
  const normalized = String(value ?? "").trim();
  if (!normalized) return null;
  if (normalized === REFUND_STATUS_COMPLETED || normalized === "환불 완료" || normalized === "완료") {
    return REFUND_STATUS_COMPLETED;
  }
  if (normalized === REFUND_STATUS_PENDING || normalized === "환불 예정" || normalized === "환불예정" || normalized === "예정" || normalized === "대기") {
    return REFUND_STATUS_PENDING;
  }
  if (normalized === REFUND_STATUS_REQUESTED || normalized === "환불 요청") {
    return REFUND_STATUS_REQUESTED;
  }
  if (normalized === REFUND_STATUS_OFFSET || normalized === "상계 처리" || normalized === "상계") {
    return REFUND_STATUS_OFFSET;
  }
  return normalized;
}

function isMissingPiiEncryptionKeyError(error: unknown): boolean {
  return error instanceof Error && error.message.includes("PII_ENCRYPTION_KEY is required to decrypt this value");
}

function getMostRecentStoredPaymentMethod(
  refundList: Array<{ previousPaymentMethod?: string | null; createdAt?: Date | string | null }>,
  keepList: Array<{ previousPaymentMethod?: string | null; createdAt?: Date | string | null }>,
): string | null {
  const candidates = [
    ...refundList.map((row) => ({
      previousPaymentMethod: row.previousPaymentMethod,
      createdAt: row.createdAt,
    })),
    ...keepList.map((row) => ({
      previousPaymentMethod: row.previousPaymentMethod,
      createdAt: row.createdAt,
    })),
  ].sort((a, b) => {
    const aTime = a.createdAt ? new Date(a.createdAt).getTime() : 0;
    const bTime = b.createdAt ? new Date(b.createdAt).getTime() : 0;
    return bTime - aTime;
  });

  for (const candidate of candidates) {
    const normalized = normalizeRestorablePaymentMethod(candidate.previousPaymentMethod);
    if (normalized) return normalized;
  }

  return null;
}

async function resolvePreviousFinancialBasePaymentMethod(
  contractId: string,
  contract?: {
    paymentMethod?: string | null;
    paymentConfirmed?: boolean | null;
  } | null,
): Promise<string> {
  const refundList = await storage.getRefundsByContract(contractId);
  return getMostRecentStoredPaymentMethod(refundList, []) ?? resolveDepositFallbackPaymentMethod(contract);
}

function parseEffectiveFrom(value: unknown): Date | null {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value;
  if (typeof value === "string") {
    const raw = value.trim();
    if (!raw) return null;
    const normalized = /^\d{4}-\d{2}-\d{2}$/.test(raw) ? `${raw}T00:00:00` : raw;
    const parsed = new Date(normalized);
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return null;
}

function getKoreanDateKey(value: Date | string | number): string | null {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);

  const year = parts.find((part) => part.type === "year")?.value;
  const month = parts.find((part) => part.type === "month")?.value;
  const day = parts.find((part) => part.type === "day")?.value;
  if (!year || !month || !day) return null;
  return `${year}-${month}-${day}`;
}

function getKoreanYearMonthKey(value: Date | string | number): string | null {
  const dateKey = getKoreanDateKey(value);
  if (!dateKey) return null;
  return dateKey.slice(0, 7);
}

function shiftKoreanYearMonthKey(yearMonth: string, monthDelta: number): string {
  const baseDate = new Date(`${yearMonth}-01T12:00:00+09:00`);
  if (Number.isNaN(baseDate.getTime())) return yearMonth;
  baseDate.setMonth(baseDate.getMonth() + monthDelta);
  const shifted = getKoreanYearMonthKey(baseDate);
  return shifted || yearMonth;
}

function normalizeToKoreanContractDate(value: Date | string | number | null | undefined): Date | null {
  return normalizeToKoreanDateOnly(value);
}

function isWithinKoreanDateRange(
  value: Date | string | number,
  start?: string,
  end?: string,
): boolean {
  const targetKey = getKoreanDateKey(value);
  if (!targetKey) return false;

  const startKey = start ? getKoreanDateKey(start) : null;
  const endKey = end ? getKoreanDateKey(end) : null;

  if (startKey && endKey) {
    const rangeStart = startKey <= endKey ? startKey : endKey;
    const rangeEnd = startKey <= endKey ? endKey : startKey;
    return targetKey >= rangeStart && targetKey <= rangeEnd;
  }
  if (startKey) return targetKey >= startKey;
  if (endKey) return targetKey <= endKey;
  return true;
}

const MARKETING_DEPARTMENT = "\uB9C8\uCF00\uD305\uD300";
const REGIONAL_DEPARTMENT = "\uD0C0\uC9C0\uC5ED\uD300";
const REGIONAL_MONTHLY_OPEN_TARGET = 10000;
const REGIONAL_MONTHLY_CHURN_DEFENSE_TARGET = 3000;
const WORK_STATUS_EMPLOYED = "\uC7AC\uC9C1\uC911";
const WORK_STATUS_ON_LEAVE = "\uD734\uC9C1\uC911";
const WORK_STATUS_RESIGNED = "\uD1F4\uC0AC";
const REGIONAL_CHANGED_STATUS_SENTINEL = "__changed__";

function normalizeText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeCompactText(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function getRegionalDealStageLabel(stage: unknown): string {
  const normalized = normalizeText(stage);
  if (normalized === "churned") return "해지";
  if (normalized === "active") return "개통";
  return "인입";
}

function normalizeRegionalDealContractStatus(value: unknown, stageHint?: string | null): string {
  const normalized = normalizeText(value);
  if (!normalized || normalized === "(공백)") return "";
  if (normalized === REGIONAL_CHANGED_STATUS_SENTINEL) return "변경";
  if (normalized === "변경") return "변경";
  if (normalized === "해지") return "해지";
  if (normalized === "개통" || normalized === "등록" || normalized === "유지") return "개통";
  if (
    normalized === "인입" ||
    normalized === "신규" ||
    normalized === "신규상담" ||
    normalized === "등록/갱신예정"
  ) {
    return "인입";
  }
  if (stageHint === "churned") return "해지";
  if (stageHint === "active") return "개통";
  if (stageHint === "new") return "인입";
  return normalized;
}

function getRegionalDealStageFromStatus(value: unknown): "new" | "active" | "churned" | null {
  const normalized = normalizeRegionalDealContractStatus(value);
  if (!normalized) return null;
  if (normalized === "변경") return null;
  if (normalized === "해지") return "churned";
  if (normalized === "개통") return "active";
  return "new";
}

function normalizeRegionalDealDate(value: Date | string | number | null | undefined): Date | null {
  const normalized = normalizeToKoreanContractDate(value);
  if (!normalized) return null;
  if (normalized.getFullYear() < 2000) return null;
  return normalized;
}

function addDaysToKoreanDate(value: Date | string | number | null | undefined, dayDelta: number): Date | null {
  return normalizeRegionalDealDate(addKoreanBusinessDays(value, dayDelta));
}

function getRegionalDealOpenAnalyticsDate(
  deal: Pick<Deal, "contractEndDate" | "contractStartDate" | "inboundDate" | "createdAt">,
): Date | null {
  return (
    normalizeRegionalDealDate(deal.contractEndDate) ??
    addDaysToKoreanDate(deal.contractStartDate, 1) ??
    normalizeRegionalDealDate(deal.contractStartDate) ??
    normalizeRegionalDealDate(deal.inboundDate) ??
    normalizeRegionalDealDate(deal.createdAt)
  );
}

function parseLooseTimelineDateKey(value: unknown): string | null {
  const text = normalizeText(value);
  if (!text) return null;
  const matched = text.match(/(\d{4})\D+(\d{1,2})\D+(\d{1,2})/);
  if (!matched) return null;
  const [, year, month, day] = matched;
  return `${year}-${month.padStart(2, "0")}-${day.padStart(2, "0")}`;
}

type RegionalTimelineLineEvent = {
  dateKey: string;
  yearMonth: string;
  count: number;
};

function parseRegionalTimelineAddEventDetail(content: string): RegionalTimelineLineEvent | null {
  const matched = String(content || "").match(/\[회선추가\].*?개통일\s+([^/]+?)\s*\/\s*(\d+)\s*회선\s*추가/i);
  if (!matched) return null;
  const dateKey = parseLooseTimelineDateKey(matched[1]);
  const count = Math.max(Number.parseInt(matched[2] || "0", 10) || 0, 0);
  if (!dateKey || count <= 0) return null;
  return {
    dateKey,
    yearMonth: dateKey.slice(0, 7),
    count,
  };
}

function parseRegionalTimelineAddEvent(content: string): { yearMonth: string; count: number } | null {
  const detail = parseRegionalTimelineAddEventDetail(content);
  return detail ? { yearMonth: detail.yearMonth, count: detail.count } : null;
}

function parseRegionalTimelinePartialChurnEventDetail(content: string): RegionalTimelineLineEvent | null {
  const matched = String(content || "").match(/\[부분해지\]\s*([0-9./\-\s]+?)\s+(\d+)\s*회선\s*해지/i);
  if (!matched) return null;
  const dateKey = parseLooseTimelineDateKey(matched[1]);
  const count = Math.max(Number.parseInt(matched[2] || "0", 10) || 0, 0);
  if (!dateKey || count <= 0) return null;
  return {
    dateKey,
    yearMonth: dateKey.slice(0, 7),
    count,
  };
}

function parseRegionalTimelinePartialChurnEvent(content: string): { yearMonth: string; count: number } | null {
  const detail = parseRegionalTimelinePartialChurnEventDetail(content);
  return detail ? { yearMonth: detail.yearMonth, count: detail.count } : null;
}

function buildRegionalMonthlyYearMonthRange(_start?: string | null, _end?: string | null): string[] {
  const anchorDate = normalizeToKoreanContractDate(new Date()) ?? new Date();
  const currentMonthStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
  const cursor = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth() - 4, 1);
  const stop = new Date(currentMonthStart.getFullYear(), currentMonthStart.getMonth(), 1);
  const keys: string[] = [];

  while (cursor <= stop && keys.length < 5) {
    keys.push(`${cursor.getFullYear()}-${String(cursor.getMonth() + 1).padStart(2, "0")}`);
    cursor.setMonth(cursor.getMonth() + 1);
  }

  if (keys.length === 0) {
    const fallbackKey = getKoreanYearMonthKey(anchorDate);
    return fallbackKey ? [fallbackKey] : [];
  }
  return keys;
}

function normalizeWorkStatus(value: unknown): string {
  const normalized = normalizeText(value);
  if (
    !normalized ||
    normalized === "\uADFC\uBB34" ||
    normalized === "\uADFC\uBB34\uC911" ||
    normalized === "\uC7AC\uC9C1" ||
    normalized === WORK_STATUS_EMPLOYED
  ) {
    return WORK_STATUS_EMPLOYED;
  }
  if (normalized === "\uD734\uC9C1" || normalized === WORK_STATUS_ON_LEAVE) {
    return WORK_STATUS_ON_LEAVE;
  }
  if (normalized === WORK_STATUS_RESIGNED) {
    return WORK_STATUS_RESIGNED;
  }
  return normalized;
}

function isWorkStatusBlockedForLogin(value: unknown): boolean {
  const normalized = normalizeWorkStatus(value);
  return normalized === WORK_STATUS_ON_LEAVE || normalized === WORK_STATUS_RESIGNED;
}

function normalizeLower(value: unknown): string {
  return normalizeText(value).toLowerCase();
}

function toAmount(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function toWholeAmount(value: unknown): number {
  return Math.max(0, Math.floor(toAmount(value)));
}

function toSignedWholeAmount(value: unknown): number {
  const parsed = toAmount(value);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : 0;
}

function getKeepDeductionAmount(contract: { totalKeep?: number | null }): number {
  return Math.max(0, toAmount(contract?.totalKeep));
}

function getEffectiveSalesAmount(contract: { cost?: number | null; totalKeep?: number | null }): number {
  return toAmount(contract?.cost) - getKeepDeductionAmount(contract);
}

function getGrossSalesAmount(contract: { cost?: number | null; totalRefund?: number | null; contractStatus?: string | null }): number {
  if (isWithdrawnContract(contract)) return 0;
  return toAmount(contract?.cost) + Math.max(0, toAmount(contract?.totalRefund));
}

const SLOT_PRODUCT_ALIAS_KEYS = new Set(
  [
    "포유",
    "bbs쿠팡",
    "스티젠",
    "프라다",
    "가드",
    "베라",
    "소보루플러스",
    "dex",
    "deep",
    "자몽",
    "루나",
    "엘릭서",
    "피코",
    "말차트래픽",
    "블렌딩",
    "일루마",
    "엘리트",
    "삿포로",
    "플레이스트래픽",
    "언더더딜트래픽",
    "스캔들",
    "랭크업",
    "블루",
    "네이버자동완성",
    "토마토",
    "웹사이트상위",
    "바이럴m총판",
    "아담",
    "자동완성슬롯",
    "포유플레이스",
    "라칸트래픽",
    "앤드류트래픽",
    "웹사이트월보장",
    "플레이스월보장",
    "top",
    "갤럭시",
    "큐랭",
    "1219",
    "웹사이트슬롯",
    "웹사이트트래픽",
    "삿포로트래픽",
    "메리트자완",
    "탑인",
    "헤르메스",
    "보스",
    "뮤즈",
    "네이버함찾",
    "상품찜",
    "커뮤니티침투",
    "인기글월보장",
    "마멘토월간인기글",
  ].map((value) => normalizeText(value).replace(/\s+/g, "").toLowerCase()),
);

const VIRAL_PRODUCT_ALIAS_KEYS = new Set(
  [
    "제작영수증리뷰",
    "가구매리뷰",
    "가구매리뷰실배송",
    "가구매리뷰자사몰",
    "가구매리뷰카카오",
    "가구매리뷰옥션",
    "가구매리뷰g마켓",
    "가구매리뷰앱",
    "페이백대행",
    "ai블로그배포",
    "구글플레이스리뷰",
    "카카오맵리뷰",
    "영수증리뷰",
    "준최블배포",
    "예약자리뷰",
    "원고대행",
    "최블배포",
    "언론송출",
    "카페배포",
    "브랜드블로그",
    "브랜드블로그프리미엄",
    "바비톡상담",
    "브랜드인스타",
    "기자단",
    "블로그리뷰",
    "지식인추천좋아요",
    "지식인건바이",
    "체험단",
    "블로그체험단",
    "인스타체험단",
    "촬영단",
    "리뷰",
    "모두닥리뷰",
    "다알려드림지수플",
    "마멘토인기글",
    "인포그래픽",
    "당근후기",
  ].map((value) => normalizeText(value).replace(/\s+/g, "").toLowerCase()),
);

function isRegionalKeyword(value: unknown): boolean {
  const normalized = normalizeText(value).replace(/\s+/g, "");
  return normalized.includes("\uD0C0\uC9C0\uC5ED");
}

const REGIONAL_UNPAID_SHEET_NAME = "\u0032\uAC1C\uC6D4\uC774\uC0C1";
const REGIONAL_UNPAID_EXCLUDE_LABELS = ["\uC7A5\uAE30\uC5F0\uCCB4\uACE0\uAC1D", "\uC9C1\uC6D0\uD574\uC9C0\uB300\uC0C1"] as const;

function isRegionalUnpaidExcludedTarget(value: unknown): boolean {
  const normalized = normalizeText(value);
  if (!normalized) return false;
  return REGIONAL_UNPAID_EXCLUDE_LABELS.some((label) => normalized.includes(label));
}

type RegionalUnpaidColumn = {
  key: string;
  label: string;
};

type RegionalUnpaidMonthItem = {
  label: string;
  originalAmount: number;
  paidAmount: number;
  remainingAmount: number;
};

type RegionalUnpaidPaymentHistory = {
  processedAt: string;
  processedBy: string | null;
  totalPaidAmount: number;
  items: Array<{ label: string; amount: number }>;
};

type RegionalUnpaidRowMeta = {
  rowId: string;
  billingAccountNumber: string;
  unpaidTotalAmount: number;
  paidTotalAmount: number;
  remainingAmount: number;
  status: string;
  monthItems: RegionalUnpaidMonthItem[];
  paymentHistory: RegionalUnpaidPaymentHistory[];
};

type RegionalUnpaidParsed = {
  sheetName: string;
  columns: RegionalUnpaidColumn[];
  rows: Record<string, unknown>[];
  excludedCount: number;
};

const REGIONAL_UNPAID_STATUS_UNPAID = "미납";
const REGIONAL_UNPAID_STATUS_PARTIAL = "부분 납부완료";
const REGIONAL_UNPAID_STATUS_COMPLETED = "미납금 납부완료";

function normalizeRegionalUnpaidToken(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, "").toLowerCase();
}

function normalizeBillingAccountNumber(value: unknown): string {
  return normalizeText(value).replace(/\s+/g, "");
}

function toRegionalUnpaidAmount(value: unknown): number {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : 0;
  }
  const normalized = normalizeText(value).replace(/[^0-9.-]/g, "");
  if (!normalized) return 0;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRegionalUnpaidMonthLabel(label: string): boolean {
  const compact = normalizeRegionalUnpaidToken(label);
  return /^\d{4}[-./]\d{2}$/.test(compact);
}

function findRegionalUnpaidColumn(columns: RegionalUnpaidColumn[], label: string): RegionalUnpaidColumn | undefined {
  const target = normalizeRegionalUnpaidToken(label);
  return columns.find((column) => normalizeRegionalUnpaidToken(column.label) === target);
}

function computeRegionalUnpaidStatus(paidTotalAmount: number, remainingAmount: number): string {
  if (remainingAmount <= 0) return REGIONAL_UNPAID_STATUS_COMPLETED;
  if (paidTotalAmount > 0) return REGIONAL_UNPAID_STATUS_PARTIAL;
  return REGIONAL_UNPAID_STATUS_UNPAID;
}

function buildRegionalUnpaidRowMeta(
  row: Record<string, unknown>,
  columns: RegionalUnpaidColumn[],
  rowId: string,
): RegionalUnpaidRowMeta {
  const billingColumn = findRegionalUnpaidColumn(columns, "청구계정번호");
  const unpaidAmountColumn = findRegionalUnpaidColumn(columns, "미납금액");
  const monthColumns = columns.filter((column) => isRegionalUnpaidMonthLabel(column.label));

  const monthItems = monthColumns
    .map((column) => {
      const originalAmount = Math.max(0, toRegionalUnpaidAmount(row[column.key]));
      return {
        label: column.label,
        originalAmount,
        paidAmount: 0,
        remainingAmount: originalAmount,
      };
    })
    .filter((item) => item.originalAmount > 0);

  const monthTotal = monthItems.reduce((sum, item) => sum + item.originalAmount, 0);
  const unpaidTotalFromColumn = unpaidAmountColumn ? Math.max(0, toRegionalUnpaidAmount(row[unpaidAmountColumn.key])) : 0;
  const unpaidTotalAmount = unpaidTotalFromColumn > 0 ? unpaidTotalFromColumn : monthTotal;
  const billingAccountNumber = billingColumn
    ? normalizeBillingAccountNumber(row[billingColumn.key])
    : "";

  return {
    rowId,
    billingAccountNumber,
    unpaidTotalAmount,
    paidTotalAmount: 0,
    remainingAmount: unpaidTotalAmount,
    status: REGIONAL_UNPAID_STATUS_UNPAID,
    monthItems,
    paymentHistory: [],
  };
}

function ensureRegionalUnpaidRowMeta(
  row: Record<string, unknown>,
  columns: RegionalUnpaidColumn[],
  fallbackRowId: string,
): RegionalUnpaidRowMeta {
  const baseMeta = buildRegionalUnpaidRowMeta(row, columns, fallbackRowId);
  const candidate = row.__meta as Partial<RegionalUnpaidRowMeta> | undefined;

  if (!candidate || typeof candidate !== "object") {
    row.__meta = baseMeta;
    return baseMeta;
  }

  const baseMonthMap = new Map(baseMeta.monthItems.map((item) => [item.label, item]));
  const rawMonthItems = Array.isArray(candidate.monthItems) ? candidate.monthItems : baseMeta.monthItems;
  const normalizedMonthItems: RegionalUnpaidMonthItem[] = rawMonthItems.map((item: any) => {
    const label = normalizeText(item?.label);
    const baseItem = baseMonthMap.get(label);
    const originalAmount = Math.max(
      0,
      baseItem?.originalAmount ?? toRegionalUnpaidAmount(item?.originalAmount),
    );
    const paidAmount = Math.max(0, Math.min(toRegionalUnpaidAmount(item?.paidAmount), originalAmount));
    const rawRemaining =
      item?.remainingAmount === undefined || item?.remainingAmount === null || item?.remainingAmount === ""
        ? originalAmount - paidAmount
        : toRegionalUnpaidAmount(item?.remainingAmount);
    const remainingAmount = Math.max(0, Math.min(originalAmount - paidAmount, rawRemaining));
    return {
      label,
      originalAmount,
      paidAmount,
      remainingAmount,
    };
  }).filter((item) => item.label !== "");

  const monthItems = normalizedMonthItems.length > 0 ? normalizedMonthItems : baseMeta.monthItems;
  const monthOriginalTotal = monthItems.reduce((sum, item) => sum + item.originalAmount, 0);
  const paidByMonth = monthItems.reduce((sum, item) => sum + item.paidAmount, 0);
  const unpaidTotalAmount = Math.max(toRegionalUnpaidAmount(candidate.unpaidTotalAmount), monthOriginalTotal, baseMeta.unpaidTotalAmount);
  const paidTotalAmount = Math.max(toRegionalUnpaidAmount(candidate.paidTotalAmount), paidByMonth);
  const remainingAmount = Math.max(unpaidTotalAmount - paidTotalAmount, 0);
  const paymentHistory = Array.isArray(candidate.paymentHistory)
    ? candidate.paymentHistory.filter((history) => history && typeof history === "object")
    : [];

  const normalizedMeta: RegionalUnpaidRowMeta = {
    rowId: normalizeText(candidate.rowId) || baseMeta.rowId,
    billingAccountNumber: normalizeBillingAccountNumber(candidate.billingAccountNumber || baseMeta.billingAccountNumber),
    unpaidTotalAmount,
    paidTotalAmount,
    remainingAmount,
    status: computeRegionalUnpaidStatus(paidTotalAmount, remainingAmount),
    monthItems,
    paymentHistory: paymentHistory as RegionalUnpaidPaymentHistory[],
  };

  row.__meta = normalizedMeta;
  return normalizedMeta;
}

function createRegionalUnpaidColumnKey(label: string, index: number, usedKeys: Set<string>): string {
  const safeBase = label
    .replace(/\s+/g, "_")
    .replace(/[^a-zA-Z0-9_\uAC00-\uD7A3]/g, "")
    .toLowerCase();
  let key = safeBase || `column_${index + 1}`;
  let suffix = 2;
  while (usedKeys.has(key)) {
    key = `${safeBase || `column_${index + 1}`}_${suffix}`;
    suffix += 1;
  }
  usedKeys.add(key);
  return key;
}

function parseRegionalUnpaidWorkbook(fileBuffer: Buffer): RegionalUnpaidParsed {
  const workbook = XLSX.read(fileBuffer, { type: "buffer" });
  const compact = (value: unknown) => normalizeText(value).replace(/\s+/g, "").toLowerCase();

  const targetSheetToken = compact(REGIONAL_UNPAID_SHEET_NAME);
  const sheetName =
    workbook.SheetNames.find((name) => compact(name) === targetSheetToken) ??
    workbook.SheetNames.find((name) => {
      const token = compact(name);
      return token.includes("2\uAC1C\uC6D4") && token.includes("\uC774\uC0C1");
    }) ??
    workbook.SheetNames[0];

  if (!sheetName) {
    throw new Error("\uC5D1\uC140 \uC2DC\uD2B8\uB97C \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  }

  const sheet = workbook.Sheets[sheetName];
  const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" }) as unknown[][];

  const serviceHeaderToken = compact("\uC11C\uBE44\uC2A4\uAD6C\uBD84");
  const targetHeaderToken = compact("\uB300\uC0C1\uC548\uB0B4");

  let headerRowIndex = matrix.findIndex(
    (row) =>
      Array.isArray(row) &&
      row.some((value) => compact(value) === serviceHeaderToken) &&
      row.some((value) => compact(value) === targetHeaderToken),
  );

  if (headerRowIndex < 0) {
    headerRowIndex = matrix.findIndex(
      (row) => Array.isArray(row) && row.filter((value) => normalizeText(value) !== "").length >= 3,
    );
  }

  if (headerRowIndex < 0) {
    throw new Error("\uC5C5\uB85C\uB4DC \uD30C\uC77C\uC5D0\uC11C \uD5E4\uB354 \uD589\uC744 \uCC3E\uC744 \uC218 \uC5C6\uC2B5\uB2C8\uB2E4.");
  }

  const rawHeaders = matrix[headerRowIndex] ?? [];
  const usedKeys = new Set<string>();
  const columnsWithIndex = rawHeaders
    .map((header, index) => {
      const label = normalizeText(header);
      if (!label) return null;
      const key = createRegionalUnpaidColumnKey(label, index, usedKeys);
      return { key, label, index };
    })
    .filter((value): value is { key: string; label: string; index: number } => value !== null);

  const targetColumn = columnsWithIndex.find((column) => compact(column.label) === targetHeaderToken);
  const columns = columnsWithIndex.map(({ key, label }) => ({ key, label }));

  const rows: Record<string, unknown>[] = [];
  let excludedCount = 0;

  for (let rowIndex = headerRowIndex + 1; rowIndex < matrix.length; rowIndex += 1) {
    const rawRow = matrix[rowIndex] ?? [];
    const mapped: Record<string, unknown> = {};
    let hasValue = false;

    for (const column of columnsWithIndex) {
      const rawCell = rawRow[column.index];
      const cellValue = typeof rawCell === "string" ? rawCell.trim() : rawCell ?? "";
      mapped[column.key] = cellValue;
      if (String(cellValue).trim() !== "") hasValue = true;
    }

    if (!hasValue) continue;

    const targetValue = targetColumn ? normalizeText(mapped[targetColumn.key]) : "";
    if (isRegionalUnpaidExcludedTarget(targetValue)) {
      excludedCount += 1;
      continue;
    }

    const rowId = `${sheetName}-${rowIndex}`;
    mapped.__meta = buildRegionalUnpaidRowMeta(mapped, columns, rowId);
    rows.push(mapped);
  }

  return {
    sheetName,
    columns,
    rows,
    excludedCount,
  };
}

type ProductRateLike = {
  name: string;
  workCost: number | null;
  baseDays: number | null;
  unitPrice?: number | null;
  vatType?: string | null;
  worker?: string | null;
};

type ProductRateHistoryLike = {
  productName: string | null;
  effectiveFrom: Date | string;
  workCost: number | null;
  baseDays: number | null;
  unitPrice?: number | null;
  vatType?: string | null;
  worker?: string | null;
  createdAt?: Date | string | null;
};

function buildProductHistoryMap(histories: ProductRateHistoryLike[]) {
  const map = new Map<string, ProductRateHistoryLike[]>();
  for (const history of histories) {
    const key = (history.productName || "").trim();
    if (!key) continue;
    if (!map.has(key)) map.set(key, []);
    map.get(key)!.push(history);
  }
  Array.from(map.values()).forEach((historyList) => {
    historyList.sort((a: ProductRateHistoryLike, b: ProductRateHistoryLike) => {
      const effectiveDiff = new Date(b.effectiveFrom).getTime() - new Date(a.effectiveFrom).getTime();
      if (effectiveDiff !== 0) return effectiveDiff;
      const aCreatedAt = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const bCreatedAt = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return bCreatedAt - aCreatedAt;
    });
  });
  return map;
}

function resolveProductSnapshotByDate(
  productName: string,
  contractDate: Date | string | null | undefined,
  productMap: Map<string, ProductRateLike>,
  historyMap: Map<string, ProductRateHistoryLike[]>,
) {
  const normalizedName = (productName || "").trim();
  if (!normalizedName) return undefined;

  const historyList = historyMap.get(normalizedName) ?? [];
  if (historyList.length > 0) {
    const contractTime = contractDate ? new Date(contractDate).getTime() : Number.NaN;
    if (!Number.isNaN(contractTime)) {
      const matched = historyList.find((history) => new Date(history.effectiveFrom).getTime() <= contractTime);
      if (matched) return matched;
      return historyList[historyList.length - 1];
    }
    return historyList[0];
  }
  return productMap.get(normalizedName);
}

async function resolveFinancialPaymentMethod(contractId: string): Promise<string> {
  const [refundList, contract] = await Promise.all([
    storage.getRefundsByContract(contractId),
    storage.getContract(contractId),
  ]);

  return (
    getMostRecentStoredPaymentMethod(refundList, []) ??
    resolveDepositFallbackPaymentMethod(contract)
  );
}

async function syncFinancialPaymentMethod(
  contractId: string,
  options?: {
    deletedPreviousPaymentMethod?: string | null;
  },
): Promise<string> {
  const paymentMethod = await resolveFinancialPaymentMethod(contractId);
  const restoredPaymentMethod =
    isFinancialOverridePaymentMethod(paymentMethod)
      ? paymentMethod
      : normalizeRestorablePaymentMethod(options?.deletedPreviousPaymentMethod) ?? paymentMethod;
  await Promise.all([
    storage.updateContract(contractId, { paymentMethod: restoredPaymentMethod }),
    storage.updatePaymentByContractId(contractId, { paymentMethod: restoredPaymentMethod }),
  ]);
  return restoredPaymentMethod;
}

function getContractQuantityForWorkCost(contract: {
  addQuantity?: number | null;
  extendQuantity?: number | null;
  quantity?: number | null;
}) {
  const quantity = Math.max(Number(contract.quantity) || 0, 0);
  if (quantity > 0) return quantity;
  const addQuantity = Math.max(Number(contract.addQuantity) || 0, 0);
  const extendQuantity = Math.max(Number(contract.extendQuantity) || 0, 0);
  return Math.max(addQuantity + extendQuantity, 1);
}

type ContractProductDetailForWorkCost = {
  id?: string | null;
  productName?: string | null;
  userIdentifier?: string | null;
  vatType?: string | null;
  unitPrice?: number | null;
  days?: number | null;
  addQuantity?: number | null;
  extendQuantity?: number | null;
  quantity?: number | null;
  baseDays?: number | null;
  worker?: string | null;
  workCost?: number | null;
  fixedWorkCostAmount?: number | null;
  supplyAmount?: number | null;
  grossSupplyAmount?: number | null;
  marginAmount?: number | null;
  adjustmentType?: string | null;
};

function parseContractProductDetailsForWorkCost(rawValue: unknown): ContractProductDetailForWorkCost[] {
  if (typeof rawValue !== "string" || !rawValue.trim()) return [];

  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
      .map((item) => ({
        id: typeof item.id === "string" ? item.id : null,
        productName: typeof item.productName === "string" ? item.productName : null,
        userIdentifier: typeof item.userIdentifier === "string" ? item.userIdentifier : null,
        vatType: typeof item.vatType === "string" ? item.vatType : null,
        unitPrice: Number(item.unitPrice) || 0,
        days: Number(item.days) || 0,
        addQuantity: Number(item.addQuantity) || 0,
        extendQuantity: Number(item.extendQuantity) || 0,
        quantity: Number(item.quantity) || 0,
        baseDays: Number(item.baseDays) || 0,
        worker: typeof item.worker === "string" ? item.worker : null,
        workCost: Number(item.workCost) || 0,
        fixedWorkCostAmount:
          item.fixedWorkCostAmount === null || item.fixedWorkCostAmount === undefined
            ? null
            : Number(item.fixedWorkCostAmount) || 0,
        supplyAmount:
          item.supplyAmount === null || item.supplyAmount === undefined
            ? null
            : toSignedWholeAmount(item.supplyAmount),
        grossSupplyAmount:
          item.grossSupplyAmount === null || item.grossSupplyAmount === undefined
            ? null
            : toSignedWholeAmount(item.grossSupplyAmount),
        marginAmount:
          item.marginAmount === null || item.marginAmount === undefined
            ? null
            : toSignedWholeAmount(item.marginAmount),
        adjustmentType: typeof item.adjustmentType === "string" ? item.adjustmentType : null,
      }))
      .filter((item) => String(item.productName || "").trim().length > 0);
  } catch {
    return [];
  }
}

function getUnifiedContractQuantity(
  quantityValue: unknown,
  addQuantityValue: unknown,
  extendQuantityValue: unknown,
  fallback = 0,
) {
  const quantity = Math.max(0, Math.round(Number(quantityValue) || 0));
  if (quantity > 0) return quantity;
  const splitQuantity =
    Math.max(0, Math.round(Number(addQuantityValue) || 0)) +
    Math.max(0, Math.round(Number(extendQuantityValue) || 0));
  return splitQuantity > 0 ? splitQuantity : Math.max(0, Math.round(Number(fallback) || 0));
}

function normalizeContractProductDetailsQuantity(rawValue: unknown) {
  if (typeof rawValue !== "string" || !rawValue.trim()) return rawValue;
  try {
    const parsed = JSON.parse(rawValue);
    if (!Array.isArray(parsed)) return rawValue;
    return JSON.stringify(
      parsed.map((item) => {
        if (!item || typeof item !== "object") return item;
        return {
          ...item,
          addQuantity: 0,
          extendQuantity: 0,
          quantity: getUnifiedContractQuantity(
            (item as Record<string, unknown>).quantity,
            (item as Record<string, unknown>).addQuantity,
            (item as Record<string, unknown>).extendQuantity,
          ),
        };
      }),
    );
  } catch {
    return rawValue;
  }
}

function normalizeContractQuantityPayload<T extends Record<string, any>>(payload: T): T {
  const next: Record<string, any> = { ...payload };
  const hasQuantityFields =
    Object.prototype.hasOwnProperty.call(next, "quantity") ||
    Object.prototype.hasOwnProperty.call(next, "addQuantity") ||
    Object.prototype.hasOwnProperty.call(next, "extendQuantity");

  if (hasQuantityFields) {
    next.quantity = getUnifiedContractQuantity(next.quantity, next.addQuantity, next.extendQuantity);
    next.addQuantity = 0;
    next.extendQuantity = 0;
  }

  if (Object.prototype.hasOwnProperty.call(next, "productDetailsJson")) {
    next.productDetailsJson = normalizeContractProductDetailsQuantity(next.productDetailsJson);
  }

  return next as T;
}

function findRefundSourceProductDetail(
  contract: { productDetailsJson?: string | null },
  itemId?: string | null,
  userIdentifier?: string | null,
  productName?: string | null,
): ContractProductDetailForWorkCost | null {
  const items = parseContractProductDetailsForWorkCost(contract.productDetailsJson);
  const normalizedItemId = normalizeText(itemId);
  if (normalizedItemId) {
    const exact = items.find((item) => normalizeText(item.id) === normalizedItemId);
    if (exact) return exact;
  }

  const normalizedUserIdentifier = normalizeCompactText(userIdentifier);
  const normalizedProductName = normalizeCompactText(productName);
  if (!normalizedUserIdentifier && !normalizedProductName) return null;

  return (
    items.find(
      (item) =>
        (!normalizedUserIdentifier || normalizeCompactText(item.userIdentifier) === normalizedUserIdentifier) &&
        (!normalizedProductName || normalizeCompactText(item.productName) === normalizedProductName),
    ) || null
  );
}

function getRefundQuantitySplit(
  sourceItem: ContractProductDetailForWorkCost | null,
  refundQuantity: number,
) {
  return { addQuantity: 0, extendQuantity: 0 };
}

function getRefundContractNumber(
  sourceContract: { contractNumber?: string | null },
  refundDate: Date,
) {
  const sourceNumber = normalizeText(sourceContract.contractNumber) || "CONTRACT";
  const dateKey = getKoreanDateKey(refundDate)?.replace(/-/g, "") || "refund";
  return `${sourceNumber}-RF-${dateKey}-${crypto.randomUUID().slice(0, 8)}`;
}

function getRefundContractWorkCostAmount(
  sourceContract: { workCost?: number | null },
  sourceItem: ContractProductDetailForWorkCost | null,
  refundAmount: number,
  effectiveTargetAmount: number,
  refundQuantity: number,
  refundDays: number,
) {
  const sourceUnitWorkCost = Math.max(0, Number(sourceItem?.workCost) || 0);
  const sourceBaseDays = Math.max(1, Number(sourceItem?.baseDays) || 0, 1);
  if (sourceUnitWorkCost > 0 && refundQuantity > 0 && refundDays > 0) {
    return Math.round((sourceUnitWorkCost / sourceBaseDays) * refundQuantity * refundDays);
  }

  const sourceFixedWorkCost = Math.max(0, Number(sourceItem?.fixedWorkCostAmount) || 0);
  if (sourceFixedWorkCost > 0 && effectiveTargetAmount > 0) {
    return Math.round(sourceFixedWorkCost * (refundAmount / effectiveTargetAmount));
  }

  const sourceSupplyAmount = Math.max(0, Number(sourceItem?.supplyAmount) || 0);
  const sourceMarginAmount = Number(sourceItem?.marginAmount);
  if (sourceSupplyAmount > 0 && Number.isFinite(sourceMarginAmount)) {
    const sourceWorkCost = Math.max(0, sourceSupplyAmount - sourceMarginAmount);
    if (sourceWorkCost > 0) {
      return Math.round(sourceWorkCost * (refundAmount / sourceSupplyAmount));
    }
  }

  const contractWorkCost = Math.max(0, Number(sourceContract.workCost) || 0);
  if (contractWorkCost > 0 && effectiveTargetAmount > 0) {
    return Math.round(contractWorkCost * (refundAmount / effectiveTargetAmount));
  }

  return 0;
}

function buildRefundContractPayload(
  sourceContract: {
    id: string;
    contractNumber: string;
    contractDate: Date;
    managerId?: string | null;
    managerName: string;
    customerId?: string | null;
    customerName: string;
    products?: string | null;
    cost?: number | null;
    depositBank?: string | null;
    invoiceIssued?: string | null;
    worker?: string | null;
    workCost?: number | null;
    userIdentifier?: string | null;
    productDetailsJson?: string | null;
    paymentMethod?: string | null;
  },
  refundInput: {
    itemId?: string | null;
    userIdentifier?: string | null;
    productName?: string | null;
    days?: number | null;
    targetAmount?: number | null;
    amount: number;
    quantity?: number | null;
    refundDays?: number | null;
    worker?: string | null;
    reason?: string | null;
    refundDate: Date;
  },
  effectiveTargetAmount: number,
) {
  const sourceItem = findRefundSourceProductDetail(
    sourceContract,
    refundInput.itemId || null,
    refundInput.userIdentifier || null,
    refundInput.productName || null,
  );
  const refundQuantity = Math.max(0, Math.round(Number(refundInput.quantity) || 0));
  const refundDays = Math.max(0, Math.round(Number(refundInput.refundDays) || 0));
  const { addQuantity, extendQuantity } = getRefundQuantitySplit(sourceItem, refundQuantity);
  const refundAmount = Math.max(0, Math.round(Number(refundInput.amount) || 0));
  const refundWorkCost = getRefundContractWorkCostAmount(
    sourceContract,
    sourceItem,
    refundAmount,
    effectiveTargetAmount,
    refundQuantity,
    refundDays,
  );
  const productName = normalizeText(refundInput.productName || sourceItem?.productName || sourceContract.products) || "환불";
  const userIdentifier = normalizeText(refundInput.userIdentifier || sourceItem?.userIdentifier || sourceContract.userIdentifier);
  const vatType =
    normalizeText(sourceItem?.vatType) ||
    vatTypeFromInvoiceIssued(sourceContract.invoiceIssued) ||
    "미포함";
  const unitPrice =
    Math.max(0, Number(sourceItem?.unitPrice) || 0) ||
    (refundQuantity > 0 ? Math.round(effectiveTargetAmount / refundQuantity) : 0);
  const negativeRefundAmount = -refundAmount;
  const negativeRefundWorkCost = -refundWorkCost;
  const marginAmount = negativeRefundAmount - negativeRefundWorkCost;
  const sourceItemId = normalizeText(refundInput.itemId || sourceItem?.id);

  const productDetailsJson = JSON.stringify([
    {
      id: `refund-${sourceItemId || "item"}-${crypto.randomUUID().slice(0, 8)}`,
      productName,
      userIdentifier,
      vatType,
      unitPrice,
      days: refundDays > 0 ? -refundDays : 0,
      addQuantity,
      extendQuantity,
      quantity: refundQuantity,
      baseDays: Math.max(1, Number(sourceItem?.baseDays) || Number(refundInput.days) || 1),
      worker: normalizeText(refundInput.worker || sourceItem?.worker || sourceContract.worker),
      workCost: Math.max(0, Number(sourceItem?.workCost) || 0),
      fixedWorkCostAmount: negativeRefundWorkCost,
      disbursementStatus: "",
      supplyAmount: negativeRefundAmount,
      grossSupplyAmount:
        parseInvoiceIssuedFlag(sourceContract.invoiceIssued) === true
          ? -(refundAmount + Math.round(refundAmount * 0.1))
          : negativeRefundAmount,
      refundAmount: 0,
      negativeAdjustmentAmount: negativeRefundAmount,
      marginAmount,
      adjustmentType: CONTRACT_TYPE_REFUND,
      sourceContractId: sourceContract.id,
      sourceItemId: sourceItemId || null,
      refundReason: normalizeText(refundInput.reason),
    },
  ]);

  const noteParts = [
    `환불 계약`,
    `원계약번호: ${sourceContract.contractNumber}`,
    `원계약ID: ${sourceContract.id}`,
    sourceItemId ? `원항목ID: ${sourceItemId}` : null,
    refundInput.reason ? `사유: ${refundInput.reason}` : null,
  ].filter(Boolean);

  return {
    contractNumber: getRefundContractNumber(sourceContract, refundInput.refundDate),
    contractDate: refundInput.refundDate,
    contractName: null,
    managerId: sourceContract.managerId || undefined,
    managerName: sourceContract.managerName,
    customerId: sourceContract.customerId || undefined,
    customerName: sourceContract.customerName,
    products: productName,
    cost: negativeRefundAmount,
    days: refundDays > 0 ? -refundDays : 0,
    quantity: refundQuantity,
    addQuantity,
    extendQuantity,
    paymentConfirmed: false,
    paymentMethod: PAYMENT_METHOD_REFUND_REQUEST,
    depositBank: normalizeContractDepositBank(sourceContract.depositBank, sourceContract.paymentMethod),
    invoiceIssued: sourceContract.invoiceIssued,
    worker: normalizeText(refundInput.worker || sourceItem?.worker || sourceContract.worker),
    workCost: negativeRefundWorkCost,
    notes: noteParts.join(" / "),
    disbursementStatus: "",
    executionPaymentStatus: "입금예정",
    userIdentifier,
    productDetailsJson,
    contractType: CONTRACT_TYPE_REFUND,
    sourceContractId: sourceContract.id,
    sourceItemId: sourceItemId || null,
  };
}

function computeContractWorkCostFromProducts(
  contract: {
    products?: string | null;
    productDetailsJson?: string | null;
    contractDate?: Date | string | null;
    days?: number | null;
    addQuantity?: number | null;
    extendQuantity?: number | null;
    quantity?: number | null;
    workCost?: number | null;
  },
  allProducts: ProductRateLike[],
  allProductRateHistories: ProductRateHistoryLike[] = [],
) {
  const productMap = new Map(allProducts.map((product) => [product.name, product]));
  const historyMap = buildProductHistoryMap(allProductRateHistories);
  const storedProductDetails = parseContractProductDetailsForWorkCost(contract.productDetailsJson);

  if (storedProductDetails.length > 0) {
    const computedFromDetails = storedProductDetails.reduce((sum, item) => {
      const productName = String(item.productName || "").trim();
      if (!productName) return sum;

      if (item.fixedWorkCostAmount !== null && item.fixedWorkCostAmount !== undefined) {
        return sum + Math.max(Number(item.fixedWorkCostAmount) || 0, 0);
      }

      const matched = resolveProductSnapshotByDate(
        productName,
        contract.contractDate,
        productMap,
        historyMap,
      );
      const quantity = getContractQuantityForWorkCost(item);
      const days = Math.max(Number(item.days) || 1, 1);
      const workerUnitCost = Math.max(Number(item.workCost) || 0, Number(matched?.workCost) || 0, 0);
      if (workerUnitCost <= 0) return sum;

      const workerBaseDays = Math.max(Number(item.baseDays) || 0, Number(matched?.baseDays) || 0, 1);
      return sum + Math.round((workerUnitCost / workerBaseDays) * days * quantity);
    }, 0);

    if (computedFromDetails > 0) return computedFromDetails;
  }

  const quantity = getContractQuantityForWorkCost(contract);
  const days = Math.max(Number(contract.days) || 1, 1);
  const productNames = String(contract.products || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);

  if (productNames.length > 0) {
    const computed = productNames.reduce((sum, productName) => {
      const matched = resolveProductSnapshotByDate(
        productName,
        contract.contractDate,
        productMap,
        historyMap,
      );
      const workerUnitCost = Math.max(Number(matched?.workCost) || 0, 0);
      if (workerUnitCost <= 0) return sum;
      const workerBaseDays = Math.max(Number(matched?.baseDays) || 1, 1);
      return sum + Math.round((workerUnitCost / workerBaseDays) * days * quantity);
    }, 0);
    if (computed > 0) return computed;
  }

  return Math.max(Number(contract.workCost) || 0, 0);
}

export async function registerRoutes(
  httpServer: Server,
  app: Express
): Promise<Server> {
  if (!shouldRunRuntimeSchemaEnsure() && hasDatabaseConfig) {
    try {
      await ensureCustomerKeepColumns();
      await ensureCustomerLifecycleSeedData();
    } catch (error) {
      console.warn("Customer lifecycle ensure skipped:", error);
    }
  }

  if (shouldRunRuntimeSchemaEnsure()) {
    await ensureCustomerDetailTables();
    await ensureDealCustomerDbColumns();
    await ensureRegionalUnpaidTable();
    await ensureRegionalManagementFeeTable();
    await ensureRegionalCustomerListTable();
    await ensureCustomerKeepColumns();
    await ensureCustomerLifecycleSeedData();
    await ensureDepartmentNameSpacing();
    await ensureProductColumns();
    await ensureContractColumns();
    await ensureFinancialHistoryColumns();
    await ensureDepositRefundMatchesTable();
  }

  app.post("/api/auth/login", async (req, res) => {
    try {
      const { loginId, password } = req.body;
      if (!loginId || !password) {
        return res.status(400).json({ error: "아이디와 비밀번호를 입력해주세요." });
      }
      if (isLocalAdminLogin(loginId, password)) {
        req.session.regenerate((err) => {
          if (err) {
            console.error("Session regeneration error:", err);
            return res.status(500).json({ error: "Login failed." });
          }
          req.session.userId = LOCAL_ADMIN_USER_ID;
          req.session.save((saveErr) => {
            if (saveErr) {
              console.error("Session save error:", saveErr);
              return res.status(500).json({ error: "Login failed." });
            }
            res.clearCookie("crm_logged_out");
            return res.json(localAdminUser);
          });
        });
        return;
      }      const user = await storage.getUserByLoginId(loginId);
      if (!user) {
        return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
      }
      if (!bcrypt.compareSync(password, user.password)) {
        return res.status(401).json({ error: "아이디 또는 비밀번호가 올바르지 않습니다." });
      }
      if (!user.isActive) {
        return res.status(403).json({ error: "비활성화된 계정입니다." });
      }
      if (isWorkStatusBlockedForLogin(user.workStatus)) {
        const blockedStatus = normalizeWorkStatus(user.workStatus);
        return res.status(403).json({ error: `${blockedStatus} 상태 계정은 로그인할 수 없습니다.` });
      }
      const oldSession = req.session;
      req.session.regenerate((err) => {
        if (err) {
          console.error("Session regeneration error:", err);
          return res.status(500).json({ error: "로그인에 실패했습니다." });
        }
        req.session.userId = user.id;
        req.session.save((saveErr) => {
          if (saveErr) {
            console.error("Session save error:", saveErr);
            return res.status(500).json({ error: "로그인에 실패했습니다." });
          }
          res.clearCookie("crm_logged_out");
          const { password: _, ...safeUser } = user;

          storage.createSystemLog({
            userId: user.id,
            loginId: user.loginId,
            userName: user.name,
            action: "시스템에 로그인했습니다.",
            actionType: "login",
            ipAddress: req.ip || req.socket.remoteAddress || "",
            userAgent: req.headers["user-agent"] || "",
          }).catch(err => console.error("Login log error:", err));

          res.json(safeUser);
        });
      });
    } catch (error) {
      console.error("Login error:", error);
      res.status(500).json({ error: "로그인에 실패했습니다." });
    }
  });

  app.post("/api/auth/logout", async (req, res) => {
    const userId = req.session.userId;
    let logUser: any = null;
    if (userId) {
      logUser = getLocalAdminUserBySession(userId);
    }
    if (userId && !logUser) {
      try {
        logUser = await storage.getUser(userId);
      } catch (_) {}
    }

    req.session.destroy((err) => {
      if (err) {
        return res.status(500).json({ error: "로그아웃에 실패했습니다." });
      }

      if (logUser) {
        storage.createSystemLog({
          userId: logUser.id,
          loginId: logUser.loginId,
          userName: logUser.name,
          action: "시스템에서 로그아웃했습니다.",
          actionType: "logout",
          ipAddress: req.ip || req.socket.remoteAddress || "",
          userAgent: req.headers["user-agent"] || "",
        }).catch(err => console.error("Logout log error:", err));
      }

      res.clearCookie("crm.sid");
      res.cookie("crm_logged_out", "1", { httpOnly: true, sameSite: "lax" });
      res.json({ success: true });
    });
  });

  app.get("/api/auth/me", autoLoginDev, async (req, res) => {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Not authenticated" });
    }
    const localUser = getLocalAdminUserBySession(req.session.userId);
    if (localUser) {
      return res.json(localUser);
    }    try {
      const user = await storage.getUser(req.session.userId);
      if (!user) {
        req.session.destroy(() => {});
        return res.status(401).json({ error: "User not found" });
      }
      const { password: _, ...safeUser } = user;
      res.json(safeUser);
    } catch (error) {
      res.status(500).json({ error: "Failed to get user" });
    }
  });

  app.put("/api/auth/profile", requireAuth, async (req, res) => {
    try {
      const userId = req.session.userId;
      if (!userId) return res.status(401).json({ error: "Not authenticated" });

      let pwMinLength = 8;
      try {
        const pwSetting = await storage.getSystemSetting("password_min_length");
        if (pwSetting) pwMinLength = parseInt(pwSetting.settingValue) || 8;
      } catch {}

      const profileSchema = z.object({
        phone: z.string().optional(),
        email: z.string().email("올바른 이메일 형식이 아닙니다.").optional().or(z.literal("")),
        currentPassword: z.string().optional(),
        newPassword: z.string().min(pwMinLength, `비밀번호는 최소 ${pwMinLength}자 이상이어야 합니다.`)
          .regex(/[A-Za-z]/, "비밀번호에 영문자가 포함되어야 합니다.")
          .regex(/[0-9]/, "비밀번호에 숫자가 포함되어야 합니다.")
          .regex(/[!@#$%^&*(),.?":{}|<>]/, "비밀번호에 특수문자가 포함되어야 합니다.")
          .optional(),
      });

      const parsed = profileSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "잘못된 요청입니다." });
      }

      const { phone, email, currentPassword, newPassword } = parsed.data;

      const currentUser = await storage.getUser(userId);
      if (!currentUser) return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });

      const updateData: Record<string, any> = {};

      if (phone !== undefined) updateData.phone = phone;
      if (email !== undefined) updateData.email = email || null;

      if (newPassword) {
        if (!currentPassword) {
          return res.status(400).json({ error: "현재 비밀번호를 입력해주세요." });
        }
        const valid = await bcrypt.compare(currentPassword, currentUser.password);
        if (!valid) {
          return res.status(400).json({ error: "현재 비밀번호가 일치하지 않습니다." });
        }
        updateData.password = await bcrypt.hash(newPassword, 10);
        updateData.lastPasswordChangeAt = new Date();
      }

      if (Object.keys(updateData).length === 0) {
        return res.status(400).json({ error: "변경할 정보가 없습니다." });
      }

      const updated = await storage.updateUser(userId, updateData);
      if (!updated) return res.status(500).json({ error: "업데이트에 실패했습니다." });

      const { password: _, ...safeUser } = updated;
      res.json(safeUser);
    } catch (error) {
      console.error("Error updating profile:", error);
      res.status(500).json({ error: "프로필 업데이트에 실패했습니다." });
    }
  });

  function isPermissionAdminRole(role?: string | null) {
    const normalizedRole = String(role || "").trim();
    return PERMISSION_ADMIN_ROLES.includes(normalizedRole) || INTENDED_PERMISSION_ADMIN_ROLES.includes(normalizedRole);
  }

  function isExecutiveUser(user?: { role?: string | null; department?: string | null } | null) {
    if (!user) return false;
    return isPermissionAdminRole(user.role) || EXECUTIVE_DEPARTMENTS.has(String(user.department || "").trim());
  }

  async function hasPermissionSettingsAccess(user?: { id?: string | null; role?: string | null; department?: string | null } | null) {
    if (!user?.id) return false;
    if (isPermissionAdminRole(user.role)) return true;
    const permissions = await storage.getPagePermissionsByUser(user.id);
    return permissions.some((permission) => permission.pageKey === "permissions");
  }

  async function requireExecutiveUserManagement(req: Request, res: Response, next: NextFunction) {
    if (!req.session.userId) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }
    const currentUser = await storage.getUser(req.session.userId);
    if (!isExecutiveUser(currentUser)) {
      return res.status(403).json({ error: "사용자 등록, 삭제, 전체 수정은 경영진만 가능합니다." });
    }
    next();
  }

  async function requirePermissionSettingsAccess(req: Request, res: Response, next: NextFunction) {
    if (!req.session.userId) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }
    const currentUser = await storage.getUser(req.session.userId);
    if (!(await hasPermissionSettingsAccess(currentUser))) {
      return res.status(403).json({ error: "권한설정 권한이 있는 사용자만 권한을 부여할 수 있습니다." });
    }
    next();
  }

  async function requireAdmin(req: Request, res: Response, next: NextFunction) {
    if (!req.session.userId) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }
    const currentUser = await storage.getUser(req.session.userId);
    if (!currentUser || !isPermissionAdminRole(currentUser.role)) {
      return res.status(403).json({ error: "관리자 권한이 필요합니다." });
    }
    next();
  }

  async function requireDepositActionAllowed(req: Request, res: Response, next: NextFunction) {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Login is required." });
    }

    const currentUser = await storage.getUser(req.session.userId);
    const userDepartment = String(currentUser?.department || "").trim();
    const userRole = String(currentUser?.role || "").trim();
    const canManageDeposits =
      DEPOSIT_ACTION_ALLOWED_DEPARTMENTS.has(userDepartment) ||
      PERMISSION_ADMIN_ROLES.includes(userRole);
    if (!canManageDeposits) {
      return res.status(403).json({ error: "입금완료 등록, 엑셀 업로드, 수정, 삭제는 경영지원팀/개발팀 또는 대표이사/총괄이사/개발자만 가능합니다." });
    }

    next();
  }

  async function requireRegionalCustomerListManageAllowed(req: Request, res: Response, next: NextFunction) {
    if (!req.session.userId) {
      return res.status(401).json({ error: "Login is required." });
    }

    const currentUser = await storage.getUser(req.session.userId);
    const userDepartment = String(currentUser?.department || "").trim();
    const userRole = String(currentUser?.role || "").trim();
    const canManageRegionalCustomerList =
      REGIONAL_CUSTOMER_LIST_ALLOWED_DEPARTMENTS.has(userDepartment) ||
      PERMISSION_ADMIN_ROLES.includes(userRole);

    if (!canManageRegionalCustomerList) {
      return res.status(403).json({ error: "고객리스트 등록, 수정, 삭제는 타지역팀 또는 대표이사/총괄이사/개발자만 가능합니다." });
    }

    next();
  }

  app.use("/api/users", requireAuth);
  app.use("/api/customers", requireAuth);
  app.use("/api/contacts", requireAuth);
  app.use("/api/deals", requireAuth);
  app.use("/api/activities", requireAuth);
  app.use("/api/payments", requireAuth);
  app.use("/api/system-logs", requireAuth);
  app.use("/api/products", requireAuth);
  app.use("/api/product-rate-histories", requireAuth);
  app.use("/api/renewal-alerts", requireAuth);
  app.use("/api/contracts", requireAuth);
  app.use("/api/refunds", requireAuth);
  app.use("/api/permissions", requireAuth);
  app.use("/api/system-settings", requireAuth);
  app.use("/api/stats", requireAuth);

  app.get("/api/users", async (_req, res) => {
    try {
      const users = await storage.getUsers();
      const safeUsers = users.map(({ password: _, ...u }) => u);
      res.json(safeUsers);
    } catch (error) {
      console.error("Error fetching users:", error);
      res.status(500).json({ error: "Failed to fetch users" });
    }
  });

  async function getPasswordPolicy() {
    let minLength = 8;
    try {
      const setting = await storage.getSystemSetting("password_min_length");
      if (setting) minLength = parseInt(setting.settingValue) || 8;
    } catch {}
    return z.string()
      .min(minLength, `비밀번호는 ${minLength}자 이상이어야 합니다.`)
      .regex(/[A-Za-z]/, "비밀번호에 영문자가 포함되어야 합니다.")
      .regex(/[0-9]/, "비밀번호에 숫자가 포함되어야 합니다.")
      .regex(/[!@#$%^&*(),.?":{}|<>]/, "비밀번호에 특수문자가 포함되어야 합니다.");
  }

  app.post("/api/users", requireExecutiveUserManagement, requirePermissionSettingsAccess, async (req, res) => {
    try {
      const parsed = insertUserSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid user data", details: parsed.error });
      }
      const passwordPolicy = await getPasswordPolicy();
      const pwCheck = passwordPolicy.safeParse(parsed.data.password);
      if (!pwCheck.success) {
        return res.status(400).json({ error: pwCheck.error.errors[0]?.message || "비밀번호 정책을 충족하지 않습니다." });
      }
      parsed.data.password = await bcrypt.hash(parsed.data.password, 10);
      const user = await storage.createUser(parsed.data);
      const role = parsed.data.role;
      const defaultPages = role ? filterAssignablePageKeys(positionDefaultPages[role] ?? []) : [];
      if (defaultPages.length > 0) {
        await storage.setPagePermissions(user.id, defaultPages);
      }
      const { password: _p, ...safeUser } = user;
      res.status(201).json(safeUser);
    } catch (error: any) {
      console.error("Error creating user:", error);
      if (error?.code === "23505" || error?.constraint?.includes("login_id")) {
        return res.status(400).json({ error: "이미 존재하는 로그인ID입니다." });
      }
      res.status(500).json({ error: error?.message || "사용자 등록에 실패했습니다." });
    }
  });

  app.put("/api/users/:id", async (req, res) => {
    try {
      const userId = toSingleString(req.params.id);
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!currentUser) {
        return res.status(401).json({ error: "로그인이 필요합니다." });
      }

      const oldUser = await storage.getUser(userId);
      if (!oldUser) {
        return res.status(404).json({ error: "User not found" });
      }

      const parsed = insertUserSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid user data", details: parsed.error });
      }
      const requestedFields = Object.keys(parsed.data);
      const canEditAllUserFields = isExecutiveUser(currentUser);
      const canGrantPermissions = await hasPermissionSettingsAccess(currentUser);
      const isSelfEdit = currentUser.id === userId;

      if (!canEditAllUserFields) {
        if (!isSelfEdit) {
          return res.status(403).json({ error: "다른 사용자 정보 수정은 경영진만 가능합니다." });
        }
        const forbiddenFields = requestedFields.filter((field) => !USER_SELF_EDIT_FIELDS.has(field));
        if (forbiddenFields.length > 0) {
          return res.status(403).json({ error: "일반 사용자는 본인 비밀번호, 이메일, 연락처만 수정할 수 있습니다." });
        }
      }

      if (requestedFields.some((field) => USER_PERMISSION_FIELDS.has(field)) && !canGrantPermissions) {
        return res.status(403).json({ error: "권한설정 권한이 있는 사용자만 직책을 변경할 수 있습니다." });
      }
      if (parsed.data.password) {
        const passwordPolicy = await getPasswordPolicy();
        const pwCheck = passwordPolicy.safeParse(parsed.data.password);
        if (!pwCheck.success) {
          return res.status(400).json({ error: pwCheck.error.errors[0]?.message || "비밀번호 정책을 충족하지 않습니다." });
        }
        parsed.data.password = await bcrypt.hash(parsed.data.password, 10);
      }
      const user = await storage.updateUser(userId, parsed.data);
      if (!user) {
        return res.status(404).json({ error: "User not found" });
      }
      if (parsed.data.role && parsed.data.role !== oldUser?.role) {
        const defaultPages = filterAssignablePageKeys(positionDefaultPages[parsed.data.role] ?? []);
        await storage.setPagePermissions(user.id, defaultPages);
      }
      const { password: _pw, ...safeUpdated } = user;
      res.json(safeUpdated);
    } catch (error) {
      console.error("Error updating user:", error);
      res.status(500).json({ error: "Failed to update user" });
    }
  });

  app.delete("/api/users/:id", requireExecutiveUserManagement, async (req, res) => {
    try {
      const userId = toSingleString(req.params.id);
      await storage.deleteUser(userId);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting user:", error);
      res.status(500).json({ error: "Failed to delete user" });
    }
  });

  app.get("/api/stats", async (_req, res) => {
    try {
      const stats = await storage.getStats();
      const contracts = (await storage.getContractsWithFinancials()).filter((contract) => !isWithdrawnContract(contract));
      const users = await storage.getUsers();
      const activities = await storage.getActivities();

      const totalSales = contracts.reduce((sum, c) => sum + getEffectiveSalesAmount(c), 0);
      const totalRefunds = contracts.reduce((sum, c) => sum + (c.totalRefund || 0), 0);
      const confirmedCount = contracts.filter(c => c.paymentConfirmed).length;

      const now = new Date();
      const currentMonthKey = getKoreanYearMonthKey(now) || "";
      const lastMonthKey = currentMonthKey ? shiftKoreanYearMonthKey(currentMonthKey, -1) : "";

      const monthlyMap: Record<string, { sales: number; refunds: number; count: number }> = {};
      contracts.forEach(c => {
        const key = getKoreanYearMonthKey(c.contractDate);
        if (!key) return;
        if (!monthlyMap[key]) monthlyMap[key] = { sales: 0, refunds: 0, count: 0 };
        monthlyMap[key].sales += getEffectiveSalesAmount(c);
        monthlyMap[key].refunds += c.totalRefund || 0;
        monthlyMap[key].count += 1;
      });

      const monthlyRevenue = Object.entries(monthlyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-12)
        .map(([key, val]) => {
          const [, monthPart = "0"] = key.split("-");
          const monthNumber = Number.parseInt(monthPart, 10) || 0;
          return {
            month: String(monthNumber) + "월",
            yearMonth: key,
            sales: val.sales,
            refunds: val.refunds,
            netSales: val.sales - val.refunds,
            count: val.count,
          };
        });

      const currentMonthSales = monthlyMap[currentMonthKey]?.sales || 0;
      const lastMonthSales = monthlyMap[lastMonthKey]?.sales || 0;
      const growthRate = lastMonthSales > 0 ? Math.round(((currentMonthSales - lastMonthSales) / lastMonthSales) * 1000) / 10 : 0;

      const deptMap: Record<string, { sales: number; count: number; target: number }> = {};
      contracts.forEach(c => {
        const mgr = users.find(u => u.id === c.managerId || u.name === c.managerName);
        const dept = mgr?.department || "미지정";
        if (!deptMap[dept]) deptMap[dept] = { sales: 0, count: 0, target: 100 };
        deptMap[dept].sales += getEffectiveSalesAmount(c);
        deptMap[dept].count += 1;
      });

      const settings = await storage.getSystemSettings();
      const targetSetting = settings.find(s => s.settingKey === "monthly_sales_target");
      const monthlyTarget = targetSetting ? parseInt(targetSetting.settingValue) : 50000000;

      const departmentPerformance = Object.entries(deptMap)
        .sort(([, a], [, b]) => b.sales - a.sales)
        .map(([dept, val]) => ({
          team: dept,
          target: 100,
          achieved: monthlyTarget > 0 ? Math.round((val.sales / monthlyTarget) * 100) : 0,
          sales: val.sales,
          count: val.count,
        }));

      const weekActivity: Record<string, { calls: number; meetings: number; emails: number; notes: number }> = {};
      const dayNames = ["일", "월", "화", "수", "목", "금", "토"];
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      activities.filter(a => new Date(a.createdAt) >= oneWeekAgo).forEach(a => {
        const day = dayNames[new Date(a.createdAt).getDay()];
        if (!weekActivity[day]) weekActivity[day] = { calls: 0, meetings: 0, emails: 0, notes: 0 };
        if (a.type === "call") weekActivity[day].calls += 1;
        else if (a.type === "meeting") weekActivity[day].meetings += 1;
        else if (a.type === "email") weekActivity[day].emails += 1;
        else weekActivity[day].notes += 1;
      });

      const activityTrend = ["월", "화", "수", "목", "금"].map(day => ({
        day,
        calls: weekActivity[day]?.calls || 0,
        meetings: weekActivity[day]?.meetings || 0,
        emails: weekActivity[day]?.emails || 0,
      }));

      res.json({
        ...stats,
        totalSales,
        totalRefunds,
        netSales: totalSales - totalRefunds,
        confirmedCount,
        contractCount: contracts.length,
        currentMonthSales,
        lastMonthSales,
        growthRate,
        monthlyRevenue,
        departmentPerformance,
        activityTrend,
      });
    } catch (error) {
      console.error("Error fetching stats:", error);
      res.status(500).json({ error: "Failed to fetch stats" });
    }
  });

  app.get("/api/stats/personal", requireAuth, async (req, res) => {
    try {
      const currentUser = await storage.getUser(req.session.userId!);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }
      const startDateValue = toSingleString(req.query.startDate as string | string[] | undefined);
      const endDateValue = toSingleString(req.query.endDate as string | string[] | undefined);
      const contracts = (await storage.getContractsWithFinancials()).filter((contract) => !isWithdrawnContract(contract));
      const activities = await storage.getActivities();

      // Dashboard policy:
      // - default: only data matched by logged-in user's name
      // - exception: admin roles can view all data
      const hasFullDashboardAccess = PERMISSION_ADMIN_ROLES.includes(currentUser.role || "");
      const currentUserNameKey = normalizeText(currentUser.name);
      const isMyContract = (contract: { managerName: string | null }) =>
        currentUserNameKey !== "" && normalizeText(contract.managerName) === currentUserNameKey;

      let targetContracts = hasFullDashboardAccess
        ? contracts
        : contracts.filter((contract) => isMyContract(contract));
      let myActivities = hasFullDashboardAccess
        ? activities
        : activities.filter((activity) => (activity as any).userId === currentUser.id);

      if (startDateValue || endDateValue) {
        targetContracts = targetContracts.filter((contract) =>
          isWithinKoreanDateRange(contract.contractDate, startDateValue || undefined, endDateValue || undefined),
        );
        myActivities = myActivities.filter((activity) =>
          isWithinKoreanDateRange(activity.createdAt, startDateValue || undefined, endDateValue || undefined),
        );
      }

      const totalSales = targetContracts.reduce((sum, c) => sum + getEffectiveSalesAmount(c), 0);
      const totalRefunds = targetContracts.reduce((sum, c) => sum + (c.totalRefund || 0), 0);
      const contractCount = targetContracts.length;
      const avgContractValue = contractCount > 0 ? Math.round(totalSales / contractCount) : 0;

      const referenceDate = endDateValue
        ? new Date(`${endDateValue}T12:00:00+09:00`)
        : new Date();
      const safeReferenceDate = Number.isNaN(referenceDate.getTime()) ? new Date() : referenceDate;
      const currentMonthKey = getKoreanYearMonthKey(safeReferenceDate) || "";
      const lastMonthKey = currentMonthKey ? shiftKoreanYearMonthKey(currentMonthKey, -1) : "";

      const monthlyMap: Record<string, { sales: number; refunds: number; count: number }> = {};
      targetContracts.forEach(c => {
        const key = getKoreanYearMonthKey(c.contractDate);
        if (!key) return;
        if (!monthlyMap[key]) monthlyMap[key] = { sales: 0, refunds: 0, count: 0 };
        monthlyMap[key].sales += getEffectiveSalesAmount(c);
        monthlyMap[key].refunds += c.totalRefund || 0;
        monthlyMap[key].count += 1;
      });

      const monthlyRevenue = Object.entries(monthlyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .slice(-6)
        .map(([key, val]) => ({
          month: `${parseInt(key.split("-")[1], 10)}월`,
          yearMonth: key,
          매출: val.sales,
          환불: val.refunds,
          순매출: val.sales - val.refunds,
          건수: val.count,
        }));

      const currentMonthSales = monthlyMap[currentMonthKey]?.sales || 0;
      const lastMonthSales = monthlyMap[lastMonthKey]?.sales || 0;
      const growthRate = lastMonthSales > 0 ? Math.round(((currentMonthSales - lastMonthSales) / lastMonthSales) * 1000) / 10 : 0;

      const productMap: Record<string, number> = {};
      targetContracts.forEach(c => {
        const productName = c.products || "기타";
        if (!productMap[productName]) productMap[productName] = 0;
        productMap[productName] += getEffectiveSalesAmount(c);
      });
      const productColors = ["#135bec", "#10b981", "#f59e0b", "#8b5cf6", "#06b6d4", "#ef4444", "#ec4899"];
      const productDistribution = Object.entries(productMap)
        .sort(([, a], [, b]) => b - a)
        .map(([name, sales], i) => ({
          name,
          value: totalSales > 0 ? Math.round((sales / totalSales) * 100) : 0,
          sales,
          color: productColors[i % productColors.length],
        }));

      res.json({
        isExecutive: hasFullDashboardAccess,
        user: {
          id: currentUser.id,
          name: currentUser.name,
          role: currentUser.role,
          department: currentUser.department || "",
          workStatus: currentUser.workStatus || "",
        },
        totalSales,
        totalRefunds,
        netSales: totalSales - totalRefunds,
        contractCount,
        avgContractValue,
        currentMonthSales,
        lastMonthSales,
        growthRate,
        monthlyRevenue,
        productDistribution,
        activityCount: myActivities.length,
      });
    } catch (error) {
      console.error("Error fetching personal stats:", error);
      res.status(500).json({ error: "Failed to fetch personal stats" });
    }
  });

  const customerFileUpload = multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: 20 * 1024 * 1024 },
  });

  app.get("/api/customers", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      const rawCustomers = await storage.getCustomers();
      const customers = isCounselorPosition(currentUser?.role)
        ? rawCustomers.filter((customer) => isCustomerLifecycleStage(customer.lifecycleStage, "lead"))
        : rawCustomers;
      if (customers.length === 0) {
        res.json(customers);
        return;
      }

      const latestCounselingByCustomerId = new Map<string, any>();
      const counselingCountByCustomerId = new Map<string, number>();
      const companyConvertedAtByCustomerId = new Map<string, Date | string>();
      try {
        await ensureCustomerDetailTables();
        const counselingResult = await pool.query(
          `
            SELECT DISTINCT ON (customer_id)
                   customer_id AS "customerId",
                   counseling_date AS "lastCounselingDate",
                   content,
                   created_at AS "lastCounselingCreatedAt"
            FROM customer_counselings
            ORDER BY customer_id, counseling_date DESC, created_at DESC
          `,
        );
        counselingResult.rows.forEach((row) => {
          const decrypted = decryptRawTableRow("customer_counselings", row);
          latestCounselingByCustomerId.set(String(decrypted.customerId), decrypted);
        });
        const counselingCountResult = await pool.query(
          `
            SELECT customer_id AS "customerId", COUNT(*)::int AS "counselingCount"
            FROM customer_counselings
            GROUP BY customer_id
          `,
        );
        counselingCountResult.rows.forEach((row) => {
          counselingCountByCustomerId.set(String(row.customerId), Number(row.counselingCount) || 0);
        });
        const convertedAtResult = await pool.query(
          `
            SELECT customer_id AS "customerId", MAX(created_at) AS "companyConvertedAt"
            FROM customer_change_histories
            WHERE change_type = 'convert_to_company'
            GROUP BY customer_id
          `,
        );
        convertedAtResult.rows.forEach((row) => {
          if (row.companyConvertedAt) {
            companyConvertedAtByCustomerId.set(String(row.customerId), row.companyConvertedAt);
          }
        });
      } catch (counselingError) {
        console.warn("Customer latest counseling data skipped:", counselingError);
      }

      res.json(
        customers.map((customer) => {
          const latestCounseling = latestCounselingByCustomerId.get(String(customer.id));
          return serializeCustomerTimeFields({
            ...customer,
            lastCounselingDate: latestCounseling?.lastCounselingDate ?? null,
            lastCounselingContent: latestCounseling?.content ?? null,
            lastCounselingCreatedAt: latestCounseling?.lastCounselingCreatedAt ?? null,
            counselingCount: counselingCountByCustomerId.get(String(customer.id)) ?? 0,
            companyConvertedAt: companyConvertedAtByCustomerId.get(String(customer.id)) ?? null,
          });
        }),
      );
    } catch (error) {
      console.error("Error fetching customers:", error);
      res.status(500).json({ error: "Failed to fetch customers" });
    }
  });

  app.get("/api/customers/:id", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      if (isCounselorPosition(currentUser?.role) && !isCustomerLifecycleStage(customer.lifecycleStage, "lead")) {
        return res.status(403).json({ error: "상담원은 리드 정보만 조회할 수 있습니다." });
      }
      res.json(serializeCustomerTimeFields(customer));
    } catch (error) {
      console.error("Error fetching customer:", error);
      res.status(500).json({ error: "Failed to fetch customer" });
    }
  });

  app.post("/api/customers", async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      const body = { ...(req.body ?? {}) };
      body.lifecycleStage = isCounselorPosition(currentUser?.role)
        ? "lead"
        : body.lifecycleStage === "lead"
          ? "lead"
          : "customer";
      if (body.lifecycleStage === "customer") {
        body.customerType = "계약완료";
      }
      normalizeLeadCustomerPayload(body);
      const parsed = insertCustomerSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid customer data", details: parsed.error });
      }
      if (isCustomerLifecycleStage(parsed.data.lifecycleStage, "lead") && normalizeDuplicatePhone(parsed.data.phone).length === 0) {
        return res.status(400).json({ error: "리드 등록 시 전화번호는 필수입니다. 번호가 없으면 010-0000-0000을 입력하세요." });
      }
      const duplicate = await findLeadCustomerDuplicate(parsed.data);
      if (duplicate) {
        return res.status(409).json({ error: duplicateLeadCustomerMessage(duplicate) });
      }
      parsed.data.createdByName = currentUser?.name || "system";
      parsed.data.createdByUserId = currentUser?.id || null;
      const customer = await storage.createCustomer(parsed.data);
      res.status(201).json(customer);
    } catch (error) {
      console.error("Error creating customer:", error);
      res.status(500).json({ error: "Failed to create customer" });
    }
  });

  app.put("/api/customers/:id", async (req, res) => {
    try {
      const body = { ...(req.body ?? {}) };
      if (body.lifecycleStage === "customer") {
        body.customerType = "계약완료";
      }
      normalizeLeadCustomerPayload(body);
      const parsed = insertCustomerSchema.partial().safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid customer data", details: parsed.error });
      }
      const beforeCustomer = await storage.getCustomer(req.params.id);
      if (!beforeCustomer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        if (!isCustomerLifecycleStage(beforeCustomer.lifecycleStage, "lead")) {
          return res.status(403).json({ error: "상담원은 리드 정보만 수정할 수 있습니다." });
        }
        if (parsed.data.lifecycleStage === "customer") {
          return res.status(403).json({ error: "상담원은 고객사 전환을 수행할 수 없습니다." });
        }
      }
      const isAdminUser = isPermissionAdminRole(currentUser?.role);
      const isCompanyCustomer = isCustomerLifecycleStage(beforeCustomer.lifecycleStage, "customer");
      const requestedName = typeof parsed.data.name === "string" ? parsed.data.name.trim() : undefined;
      if (
        isCompanyCustomer &&
        !isAdminUser &&
        requestedName !== undefined &&
        requestedName !== String(beforeCustomer.name || "").trim()
      ) {
        return res.status(403).json({ error: "고객사 (회사명)은 관리자만 수정할 수 있습니다." });
      }
      if (isCompanyCustomer && !isAdminUser && parsed.data.lifecycleStage === "lead") {
        return res.status(403).json({ error: "고객사는 리드로 되돌릴 수 없습니다." });
      }

      const duplicate = await findLeadCustomerDuplicate(
        {
          name: parsed.data.name ?? beforeCustomer.name,
          phone: parsed.data.phone ?? beforeCustomer.phone,
        },
        req.params.id,
      );
      if (duplicate) {
        return res.status(409).json({ error: duplicateLeadCustomerMessage(duplicate) });
      }

      const customer = await storage.updateCustomer(req.params.id, parsed.data);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const changedKeys = Object.keys(parsed.data).filter((key) => {
        const beforeValue = (beforeCustomer as any)[key] ?? null;
        const afterValue = (customer as any)[key] ?? null;
        return String(beforeValue ?? "") !== String(afterValue ?? "");
      });

      if (changedKeys.length > 0) {
        const beforeData: Record<string, unknown> = {};
        const afterData: Record<string, unknown> = {};
        changedKeys.forEach((key) => {
          beforeData[key] = (beforeCustomer as any)[key] ?? null;
          afterData[key] = (customer as any)[key] ?? null;
        });
        const encryptedChangeHistory = encryptRawTablePayload("customer_change_histories", {
          before_data: JSON.stringify(beforeData),
          after_data: JSON.stringify(afterData),
        });

        await pool.query(
          `
            INSERT INTO customer_change_histories (
              customer_id, change_type, changed_fields, before_data, after_data, created_by
            ) VALUES ($1, $2, $3, $4, $5, $6)
          `,
          [
            req.params.id,
            "update",
            changedKeys.join(","),
            encryptedChangeHistory.before_data,
            encryptedChangeHistory.after_data,
            await getCurrentUserName(req),
          ],
        );
      }
      await writeEntityAuditLog(
        req,
        "customer",
        "update",
        customer.name || req.params.id,
        `customerId=${req.params.id}, fields=${Object.keys(parsed.data).join(",") || "-"}`,
      );
      res.json(customer);
    } catch (error) {
      console.error("Error updating customer:", error);
      res.status(500).json({ error: "Failed to update customer" });
    }
  });

  app.post("/api/customers/:id/convert-to-company", async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 고객사 전환을 수행할 수 없습니다." });
      }
      const beforeCustomer = await storage.getCustomer(req.params.id);
      if (!beforeCustomer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      if (isCustomerLifecycleStage(beforeCustomer.lifecycleStage, "customer")) {
        return res.json(beforeCustomer);
      }

      const customer = await convertCustomerToCompany(req.params.id, currentUser?.name || await getCurrentUserName(req));
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }

      const encryptedChangeHistory = encryptRawTablePayload("customer_change_histories", {
        before_data: JSON.stringify({
          lifecycleStage: beforeCustomer.lifecycleStage,
          customerType: beforeCustomer.customerType,
          managerName: beforeCustomer.managerName,
        }),
        after_data: JSON.stringify({
          lifecycleStage: customer.lifecycleStage,
          customerType: customer.customerType,
          managerName: customer.managerName,
        }),
      });

      await pool.query(
        `
          INSERT INTO customer_change_histories (
            customer_id, change_type, changed_fields, before_data, after_data, created_by
          ) VALUES ($1, $2, $3, $4, $5, $6)
        `,
        [
          req.params.id,
          "convert_to_company",
          "lifecycleStage,customerType,managerName",
          encryptedChangeHistory.before_data,
          encryptedChangeHistory.after_data,
          await getCurrentUserName(req),
        ],
      );

      await writeEntityAuditLog(
        req,
        "customer",
        "update",
        customer.name || req.params.id,
        `customerId=${req.params.id}, action=convert_to_company`,
      );

      res.json(customer);
    } catch (error) {
      console.error("Error converting customer to company:", error);
      res.status(500).json({ error: "Failed to convert customer to company" });
    }
  });

  app.delete("/api/customers/:id", async (req, res) => {
    try {
      const customer = await storage.getCustomer(req.params.id);
      if (!customer) {
        return res.status(404).json({ error: "Customer not found" });
      }
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 리드와 고객사를 삭제할 수 없습니다." });
      }
      if (isCustomerLifecycleStage(customer.lifecycleStage, "customer") && !isPermissionAdminRole(currentUser?.role)) {
        return res.status(403).json({ error: "고객사는 관리자만 삭제할 수 있습니다." });
      }
      const contractCount = await getContractCountByCustomerId(req.params.id);
      if (contractCount > 0) {
        return res.status(409).json({
          error: "계약이 연결된 고객은 삭제할 수 없습니다. 먼저 연결된 계약을 정리해주세요.",
          contractCount,
        });
      }

      await storage.deleteCustomer(req.params.id);
      await writeEntityAuditLog(
        req,
        "customer",
        "delete",
        customer.name || req.params.id,
        `customerId=${req.params.id}`,
      );
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting customer:", error);
      res.status(500).json({ error: "Failed to delete customer" });
    }
  });

  app.get("/api/customers/:id/counselings", async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        const customer = await storage.getCustomer(String(req.params.id));
        if (!customer || !isCustomerLifecycleStage(customer.lifecycleStage, "lead")) {
          return res.status(403).json({ error: "상담원은 리드 상담만 조회할 수 있습니다." });
        }
      }
      const result = await pool.query(
        `
          SELECT id, customer_id AS "customerId", counseling_date AS "counselingDate",
                 content, created_by AS "createdBy", created_at AS "createdAt"
          FROM customer_counselings
          WHERE customer_id = $1
          ORDER BY counseling_date DESC, created_at DESC
        `,
        [req.params.id],
      );
      res.json(
        result.rows.map((row) => serializeCustomerTimeFields(decryptRawTableRow("customer_counselings", row))),
      );
    } catch (error) {
      console.error("Error fetching customer counselings:", error);
      res.status(500).json({ error: "Failed to fetch customer counselings" });
    }
  });

  app.post("/api/customers/:id/counselings", autoLoginDev, requireAuth, async (req, res) => {
    try {
      const schema = z.object({
        counselingDate: z.string().min(1),
        content: z.string().min(1),
      });
      const parsed = schema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid counseling data", details: parsed.error });
      }

      const { counselingDate, content } = parsed.data;
      const parsedDate = new Date(counselingDate);
      if (Number.isNaN(parsedDate.getTime())) {
        return res.status(400).json({ error: "Invalid counseling date" });
      }
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        const customer = await storage.getCustomer(String(req.params.id));
        if (!customer || !isCustomerLifecycleStage(customer.lifecycleStage, "lead")) {
          return res.status(403).json({ error: "상담원은 리드 상담만 등록할 수 있습니다." });
        }
      }

      const inserted = await pool.query(
        `
          INSERT INTO customer_counselings (customer_id, counseling_date, content, created_by)
          VALUES ($1, $2, $3, $4)
          RETURNING id, customer_id AS "customerId", counseling_date AS "counselingDate",
                    content, created_by AS "createdBy", created_at AS "createdAt"
        `,
        [
          req.params.id,
          parsedDate,
          encryptRawTablePayload("customer_counselings", { content: content.trim() }).content,
          await getCurrentUserName(req),
        ],
      );
      res.status(201).json(serializeCustomerTimeFields(decryptRawTableRow("customer_counselings", inserted.rows[0])));
    } catch (error) {
      console.error("Error creating customer counseling:", error);
      res.status(500).json({ error: "Failed to create customer counseling" });
    }
  });

  app.delete("/api/customers/:id/counselings/:counselingId", autoLoginDev, requireAuth, async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 상담 이력을 삭제할 수 없습니다." });
      }
      await pool.query(
        `DELETE FROM customer_counselings WHERE id = $1 AND customer_id = $2`,
        [req.params.counselingId, req.params.id],
      );
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting customer counseling:", error);
      res.status(500).json({ error: "Failed to delete customer counseling" });
    }
  });

  app.get("/api/customers/:id/change-history", async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 변경이력을 조회할 수 없습니다." });
      }
      const result = await pool.query(
        `
          SELECT id, customer_id AS "customerId", change_type AS "changeType",
                 changed_fields AS "changedFields", before_data AS "beforeData",
                 after_data AS "afterData", created_by AS "createdBy", created_at AS "createdAt"
          FROM customer_change_histories
          WHERE customer_id = $1
          ORDER BY created_at DESC
        `,
        [req.params.id],
      );
      res.json(
        result.rows.map((row) =>
          serializeCustomerTimeFields(decryptRecordFields(row, CUSTOMER_CHANGE_HISTORY_RESPONSE_PII_FIELDS)),
        ),
      );
    } catch (error) {
      console.error("Error fetching customer change history:", error);
      res.status(500).json({ error: "Failed to fetch customer change history" });
    }
  });

  app.get("/api/customers/:id/files", async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 파일 정보를 조회할 수 없습니다." });
      }
      const result = await pool.query(
        `
          SELECT id, customer_id AS "customerId", file_name AS "fileName",
                 mime_type AS "mimeType", size_bytes AS "sizeBytes",
                 uploaded_by AS "uploadedBy", note, created_at AS "createdAt"
          FROM customer_files
          WHERE customer_id = $1
          ORDER BY created_at DESC
        `,
        [req.params.id],
      );
      res.json(
        result.rows.map((row) => {
          const decrypted = decryptRecordFields(row, CUSTOMER_FILE_RESPONSE_PII_FIELDS);
          return serializeCustomerTimeFields({
            ...decrypted,
            fileName: normalizeCustomerFileName(decrypted.fileName),
            note: typeof decrypted.note === "string" && decrypted.note.trim() ? decrypted.note.trim() : null,
          });
        }),
      );
    } catch (error) {
      console.error("Error fetching customer files:", error);
      res.status(500).json({ error: "Failed to fetch customer files" });
    }
  });

  app.post("/api/customers/:id/files", autoLoginDev, requireAuth, customerFileUpload.single("file"), async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 파일을 등록할 수 없습니다." });
      }
      if (!req.file) {
        return res.status(400).json({ error: "파일이 없습니다." });
      }

      const countResult = await pool.query(
        `SELECT COUNT(*)::int AS count FROM customer_files WHERE customer_id = $1`,
        [req.params.id],
      );
      const currentCount = Number(countResult.rows[0]?.count || 0);
      if (currentCount >= 5) {
        return res.status(400).json({ error: "파일은 최대 5개까지 등록 가능합니다." });
      }

      const metadataSchema = z.object({
        note: z.string().trim().max(200).optional().or(z.literal("")),
      });
      const metadata = metadataSchema.safeParse(req.body ?? {});
      if (!metadata.success) {
        return res.status(400).json({ error: "Invalid customer file metadata", details: metadata.error });
      }

      const normalizedFileName = normalizeCustomerFileName(req.file.originalname);
      const fileData = req.file.buffer.toString("base64");
      const encryptedCustomerFile = encryptRawTablePayload("customer_files", {
        file_name: normalizedFileName,
        original_file_name: req.file.originalname,
        file_data: fileData,
        note: metadata.data.note?.trim() || null,
      });
      const inserted = await pool.query(
        `
          INSERT INTO customer_files (
            customer_id, file_name, original_file_name, mime_type, size_bytes, file_data, uploaded_by, note
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
          RETURNING id, customer_id AS "customerId", file_name AS "fileName",
                    mime_type AS "mimeType", size_bytes AS "sizeBytes",
                    uploaded_by AS "uploadedBy", note, created_at AS "createdAt"
        `,
        [
          req.params.id,
          encryptedCustomerFile.file_name,
          encryptedCustomerFile.original_file_name,
          req.file.mimetype || null,
          req.file.size || 0,
          encryptedCustomerFile.file_data,
          await getCurrentUserName(req),
          encryptedCustomerFile.note,
        ],
      );
      const decryptedInserted = decryptRecordFields(inserted.rows[0], CUSTOMER_FILE_RESPONSE_PII_FIELDS);
      res.status(201).json(serializeCustomerTimeFields({
        ...decryptedInserted,
        fileName: normalizeCustomerFileName(decryptedInserted?.fileName),
        note: typeof decryptedInserted?.note === "string" && decryptedInserted.note.trim() ? decryptedInserted.note.trim() : null,
      }));
    } catch (error) {
      console.error("Error uploading customer file:", error);
      res.status(500).json({ error: "Failed to upload customer file" });
    }
  });

  app.get("/api/customers/:id/files/:fileId/download", autoLoginDev, requireAuth, async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 파일을 다운로드할 수 없습니다." });
      }
      const result = await pool.query(
        `
          SELECT id, customer_id, file_name, original_file_name, mime_type, file_data
          FROM customer_files
          WHERE id = $1 AND customer_id = $2
          LIMIT 1
        `,
        [req.params.fileId, req.params.id],
      );

      const file = result.rows[0];
      if (!file) {
        return res.status(404).json({ error: "File not found" });
      }

      const decryptedFile = decryptRawTableRow("customer_files", file);
      const fileBuffer = Buffer.from(String(decryptedFile.file_data || ""), "base64");
      const downloadFileName = normalizeCustomerFileName(decryptedFile.file_name || decryptedFile.original_file_name);
      res.setHeader("Content-Type", file.mime_type || "application/octet-stream");
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="${toAsciiDownloadFileName(downloadFileName)}"; filename*=UTF-8''${encodeURIComponent(downloadFileName)}`,
      );
      res.send(fileBuffer);
    } catch (error) {
      console.error("Error downloading customer file:", error);
      res.status(500).json({ error: "Failed to download customer file" });
    }
  });

  app.delete("/api/customers/:id/files/:fileId", autoLoginDev, requireAuth, async (req, res) => {
    try {
      const currentUser = await getSessionUser(req);
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 파일을 삭제할 수 없습니다." });
      }
      await pool.query(
        `DELETE FROM customer_files WHERE id = $1 AND customer_id = $2`,
        [req.params.fileId, req.params.id],
      );
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting customer file:", error);
      res.status(500).json({ error: "Failed to delete customer file" });
    }
  });

  app.get("/api/contacts", async (req, res) => {
    try {
      const customerId = req.query.customerId as string | undefined;
      const contacts = await storage.getContacts(customerId);
      res.json(contacts);
    } catch (error) {
      console.error("Error fetching contacts:", error);
      res.status(500).json({ error: "Failed to fetch contacts" });
    }
  });

  app.post("/api/contacts", async (req, res) => {
    try {
      const parsed = insertContactSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid contact data", details: parsed.error });
      }
      const contact = await storage.createContact(parsed.data);
      res.status(201).json(contact);
    } catch (error) {
      console.error("Error creating contact:", error);
      res.status(500).json({ error: "Failed to create contact" });
    }
  });

  app.delete("/api/contacts/:id", async (req, res) => {
    try {
      await storage.deleteContact(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting contact:", error);
      res.status(500).json({ error: "Failed to delete contact" });
    }
  });

  app.get("/api/deals", async (_req, res) => {
    try {
      const loadedDeals = await storage.getDeals();
      const partialCancelDateByDealId = new Map<string, Date | null>();
      const dealIds = loadedDeals.map((deal) => deal.id).filter(Boolean);
      if (dealIds.length > 0) {
        const timelineRows = await db
          .select({
            dealId: dealTimelines.dealId,
            content: dealTimelines.content,
            createdAt: dealTimelines.createdAt,
          })
          .from(dealTimelines)
          .where(inArray(dealTimelines.dealId, dealIds));

        for (const row of timelineRows) {
          if (!String(row.content || "").startsWith("[부분해지]")) continue;
          const existing = partialCancelDateByDealId.get(row.dealId);
          const createdAt = row.createdAt ?? null;
          if (!existing || (createdAt && createdAt > existing)) {
            partialCancelDateByDealId.set(row.dealId, createdAt);
          }
        }
      }
      const adjustedDeals: Deal[] = loadedDeals.map((deal) => ({
        ...deal,
        contractStatus:
          normalizeRegionalDealContractStatus(deal.contractStatus, deal.stage) ||
          getRegionalDealStageLabel(deal.stage),
        inboundDate: normalizeRegionalDealDate(deal.inboundDate ?? deal.expectedCloseDate) ?? deal.inboundDate,
        contractStartDate: normalizeRegionalDealDate(deal.contractStartDate),
        contractEndDate: normalizeRegionalDealDate(deal.contractEndDate),
        churnDate: normalizeRegionalDealDate(deal.churnDate),
        latestPartialCancelDate: normalizeRegionalDealDate(partialCancelDateByDealId.get(deal.id) ?? null),
      }));

      res.json(adjustedDeals);
    } catch (error) {
      console.error("Error fetching deals:", error);
      res.status(500).json({ error: "Failed to fetch deals" });
    }
  });

  app.get("/api/deals/:id", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.id);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }
      res.json(deal);
    } catch (error) {
      console.error("Error fetching deal:", error);
      res.status(500).json({ error: "Failed to fetch deal" });
    }
  });

  app.post("/api/deals", async (req, res) => {
    try {
      const body = { ...req.body };
      const dateFields = [
        "expectedCloseDate",
        "inboundDate",
        "contractStartDate",
        "contractEndDate",
        "churnDate",
        "renewalDueDate",
      ] as const;
      for (const field of dateFields) {
        if (body[field] && typeof body[field] === "string") {
          body[field] = new Date(body[field]);
        } else if (body[field] === "") {
          body[field] = null;
        }
      }

      body.expectedCloseDate = normalizeRegionalDealDate(body.expectedCloseDate);
      body.inboundDate = normalizeRegionalDealDate(body.inboundDate) ?? body.expectedCloseDate ?? null;
      body.contractStartDate = normalizeRegionalDealDate(body.contractStartDate);
      body.contractEndDate =
        normalizeRegionalDealDate(body.contractEndDate) ??
        addDaysToKoreanDate(body.contractStartDate, 1);
      body.churnDate = normalizeRegionalDealDate(body.churnDate);
      body.renewalDueDate = null;

      if ("contractStatus" in body) {
        body.contractStatus = normalizeRegionalDealContractStatus(body.contractStatus, body.stage);
        if (body.contractStatus === "변경") {
          body.contractStatus = REGIONAL_CHANGED_STATUS_SENTINEL;
        }
      }
      if (!body.contractStatus && body.stage) {
        body.contractStatus = getRegionalDealStageLabel(body.stage);
      }
      if (!body.stage && body.contractStatus) {
        body.stage = getRegionalDealStageFromStatus(body.contractStatus) || "new";
      }

      if (
        body.stage === "churned" ||
        normalizeRegionalDealContractStatus(body.contractStatus, body.stage) === "해지"
      ) {
        body.churnDate = body.churnDate ?? normalizeRegionalDealDate(new Date());
      }

      const parsed = insertDealSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid deal data", details: parsed.error });
      }
      const deal = await storage.createDeal(parsed.data);

      const stageLabel = getRegionalDealStageLabel(deal.stage);
      const tz = await getSystemTimezone();
      const dateStr = deal.inboundDate
        ? formatServerDate(new Date(deal.inboundDate), tz)
        : formatServerDate(new Date(), tz);
      await createDealTimelineAndSync({
        dealId: deal.id,
        content: `[${stageLabel}] ${dateStr} 등록`,
        authorId: null,
        authorName: "시스템",
      });
      if (deal.cancellationReason && deal.cancellationReason.trim()) {
        await ensureDealCancellationReasonTimeline({
          dealId: deal.id,
          reason: deal.cancellationReason.trim(),
          reasonDate: deal.churnDate ?? deal.createdAt ?? new Date(),
          authorId: null,
          authorName: "시스템",
        });
      }
      if (deal.notes && deal.notes.trim()) {
        await ensureDealNoteTimeline({
          dealId: deal.id,
          note: deal.notes,
          authorId: null,
          authorName: "시스템",
        });
      }

      if (deal.customerId) {
        const customer = await storage.getCustomer(deal.customerId);
        await storage.createActivity({
          type: "note",
          description: `새로운 거래 "${deal.title}"가 ${customer?.name || "고객"}에 생성되었습니다.`,
          customerId: deal.customerId,
          dealId: deal.id,
        });
      }

      res.status(201).json({
        ...deal,
        contractStatus: normalizeRegionalDealContractStatus(deal.contractStatus, deal.stage) || stageLabel,
        contractEndDate: normalizeRegionalDealDate(deal.contractEndDate),
        churnDate: normalizeRegionalDealDate(deal.churnDate),
      });
    } catch (error) {
      console.error("Error creating deal:", error);
      res.status(500).json({ error: "Failed to create deal" });
    }
  });

  app.put("/api/deals/:id", async (req, res) => {
    try {
      const body = { ...req.body };
      const stageOrStatusProvided = "stage" in body || "contractStatus" in body;
      const dateFields = [
        "expectedCloseDate",
        "inboundDate",
        "contractStartDate",
        "contractEndDate",
        "churnDate",
        "renewalDueDate",
      ] as const;
      for (const field of dateFields) {
        if (body[field] && typeof body[field] === "string") {
          body[field] = new Date(body[field]);
        } else if (body[field] === "") {
          body[field] = null;
        }
      }

      if ("expectedCloseDate" in body) body.expectedCloseDate = normalizeRegionalDealDate(body.expectedCloseDate);
      if ("inboundDate" in body || "expectedCloseDate" in body) {
        body.inboundDate = normalizeRegionalDealDate(body.inboundDate) ?? body.expectedCloseDate ?? null;
      }
      if ("contractStartDate" in body) body.contractStartDate = normalizeRegionalDealDate(body.contractStartDate);
      if ("contractEndDate" in body || "contractStartDate" in body) {
        body.contractEndDate =
          normalizeRegionalDealDate(body.contractEndDate) ??
          addDaysToKoreanDate(body.contractStartDate, 1);
      }
      if ("churnDate" in body) body.churnDate = normalizeRegionalDealDate(body.churnDate);
      if ("renewalDueDate" in body) body.renewalDueDate = null;

      if ("contractStatus" in body) {
        body.contractStatus = normalizeRegionalDealContractStatus(body.contractStatus, body.stage);
        if (body.contractStatus === "변경") {
          body.contractStatus = REGIONAL_CHANGED_STATUS_SENTINEL;
        }
      }
      if (!body.contractStatus && body.stage) {
        body.contractStatus = getRegionalDealStageLabel(body.stage);
      }
      if (!body.stage && body.contractStatus) {
        body.stage = getRegionalDealStageFromStatus(body.contractStatus) || undefined;
      }

      if (
        body.stage === "churned" ||
        normalizeRegionalDealContractStatus(body.contractStatus, body.stage) === "해지"
      ) {
        body.churnDate = body.churnDate ?? normalizeRegionalDealDate(new Date());
      } else if (stageOrStatusProvided) {
        body.churnDate = null;
      }

      const parsed = insertDealSchema.partial().safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid deal data", details: parsed.error });
      }

      const existingDeal = await storage.getDeal(req.params.id);
      if (!existingDeal) {
        return res.status(404).json({ error: "Deal not found" });
      }

      const updatePayload: Partial<InsertDeal> = { ...parsed.data };
      if (parsed.data.stage && existingDeal.stage !== parsed.data.stage) {
        if (parsed.data.stage === "churned" && existingDeal.stage !== "churned") {
          updatePayload.preChurnStage = existingDeal.stage;
        } else if (existingDeal.stage === "churned" && parsed.data.stage !== "churned") {
          updatePayload.preChurnStage = null;
        }
      }

      const deal = await storage.updateDeal(req.params.id, updatePayload);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }

      if (existingDeal && parsed.data.stage && existingDeal.stage !== parsed.data.stage) {
        const fromLabel = getRegionalDealStageLabel(existingDeal.stage);
        const toLabel = getRegionalDealStageLabel(parsed.data.stage);
        const changeTz = await getSystemTimezone();
        const changeDate = formatServerDate(new Date(), changeTz);
        const userId = (req.session as any)?.userId;
        let authorName = "시스템";
        if (userId) {
          const user = await storage.getUser(userId);
          if (user) authorName = user.name;
        }
        await createDealTimelineAndSync({
          dealId: deal.id,
          content: `[${toLabel}] ${changeDate} 상태 변경 (${fromLabel} -> ${toLabel})`,
          authorId: userId || null,
          authorName,
        });
      }

      const oldCancellationReason = (existingDeal.cancellationReason || "").trim();
      const newCancellationReason = (deal.cancellationReason || "").trim();
      if (newCancellationReason && newCancellationReason !== oldCancellationReason) {
        const userId = (req.session as any)?.userId;
        let authorName = "시스템";
        if (userId) {
          const user = await storage.getUser(userId);
          if (user) authorName = user.name;
        }
        await ensureDealCancellationReasonTimeline({
          dealId: deal.id,
          reason: newCancellationReason,
          reasonDate: deal.churnDate ?? new Date(),
          authorId: userId || null,
          authorName,
        });
      }

      const oldNote = (existingDeal.notes || "").trim();
      const newNote = (deal.notes || "").trim();
      if (newNote && newNote !== oldNote) {
        const userId = (req.session as any)?.userId;
        let authorName = "시스템";
        if (userId) {
          const user = await storage.getUser(userId);
          if (user) authorName = user.name;
        }
        await ensureDealNoteTimeline({
          dealId: deal.id,
          note: newNote,
          authorId: userId || null,
          authorName,
        });
      }

      res.json({
        ...deal,
        contractStatus:
          normalizeRegionalDealContractStatus(deal.contractStatus, deal.stage) ||
          getRegionalDealStageLabel(deal.stage),
        contractEndDate: normalizeRegionalDealDate(deal.contractEndDate),
        churnDate: normalizeRegionalDealDate(deal.churnDate),
      });
    } catch (error) {
      console.error("Error updating deal:", error);
      res.status(500).json({ error: "Failed to update deal" });
    }
  });

  app.post("/api/deals/:id/reinstate", async (req, res) => {
    try {
      const deal = await storage.getDeal(req.params.id);
      if (!deal) {
        return res.status(404).json({ error: "Deal not found" });
      }

      if (deal.stage !== "churned") {
        return res.status(400).json({ error: "해지 상태가 아닌 고객은 해지철회 할 수 없습니다." });
      }

      const restoreStage =
        deal.preChurnStage === "new" || deal.preChurnStage === "active"
          ? deal.preChurnStage
          : "active";
      const restoreLineCount = Math.max(
        Number(deal.lineCount) || 0,
        Number(deal.cancelledLineCount) || 0,
        0,
      );

      const restoredDeal = await storage.updateDeal(req.params.id, {
        stage: restoreStage,
        contractStatus: getRegionalDealStageLabel(restoreStage),
        preChurnStage: null,
        lineCount: restoreLineCount,
        cancelledLineCount: 0,
        churnDate: null,
      });

      if (!restoredDeal) {
        return res.status(500).json({ error: "Failed to restore deal" });
      }

      const changeTz = await getSystemTimezone();
      const changeDate = formatServerDate(new Date(), changeTz);
      const userId = (req.session as any)?.userId;
      let authorName = "시스템";
      if (userId) {
        const user = await storage.getUser(userId);
        if (user) authorName = user.name;
      }
      await createDealTimelineAndSync({
        dealId: restoredDeal.id,
        content: `[${getRegionalDealStageLabel(restoreStage)}] ${changeDate} 해지 철회 (해지 -> ${getRegionalDealStageLabel(restoreStage)})`,
        authorId: userId || null,
        authorName,
      });

      res.json({
        ...restoredDeal,
        contractStatus: normalizeRegionalDealContractStatus(restoredDeal.contractStatus, restoredDeal.stage),
        churnDate: null,
      });
    } catch (error) {
      console.error("Error reinstating deal:", error);
      res.status(500).json({ error: "Failed to reinstate deal" });
    }
  });

  const addLinesSchema = z.object({
    addCount: z.coerce.number().int().min(1, "추가 회선 수는 1 이상이어야 합니다."),
  });

  app.post("/api/deals/:id/add-lines", async (req, res) => {
    try {
      const parsed = addLinesSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "잘못된 요청입니다." });
      }

      const deal = await storage.getDeal(req.params.id);
      if (!deal) {
        return res.status(404).json({ error: "거래를 찾을 수 없습니다." });
      }

      const currentLines = Math.max(Number(deal.lineCount) || 0, 0);
      const currentCancelled = Math.max(Number(deal.cancelledLineCount) || 0, 0);
      const currentRemainingLines = Math.max(currentLines - currentCancelled, 0);
      if (deal.stage === "churned" || currentRemainingLines <= 0) {
        return res.status(400).json({ error: "해지된 고객에는 회선을 추가할 수 없습니다." });
      }

      const newLineCount = currentLines + parsed.data.addCount;
      const newRemainingLines = Math.max(newLineCount - currentCancelled, 0);
      const updatedDeal = await storage.updateDeal(req.params.id, {
        lineCount: newLineCount,
      });

      if (!updatedDeal) {
        return res.status(500).json({ error: "회선수 업데이트에 실패했습니다." });
      }

      const userId = (req.session as any)?.userId;
      let authorName = "시스템";
      if (userId) {
        const user = await storage.getUser(userId);
        if (user) authorName = user.name;
      }

      const tz = await getSystemTimezone();
      const addedDate = formatServerDate(new Date(), tz);
      const openedDate = formatServerDate(addDaysToKoreanDate(new Date(), 1) ?? new Date(), tz);
      await createDealTimelineAndSync({
        dealId: deal.id,
        content: `[회선추가] 추가일 ${addedDate} / 개통일 ${openedDate} / ${parsed.data.addCount}회선 추가 (${currentRemainingLines} -> ${newRemainingLines})`,
        authorId: userId || null,
        authorName,
      });

      res.json({
        ...updatedDeal,
        contractStatus:
          normalizeRegionalDealContractStatus(updatedDeal.contractStatus, updatedDeal.stage) ||
          getRegionalDealStageLabel(updatedDeal.stage),
        contractEndDate:
          normalizeRegionalDealDate(updatedDeal.contractEndDate) ??
          addDaysToKoreanDate(updatedDeal.contractStartDate, 1),
        churnDate: normalizeRegionalDealDate(updatedDeal.churnDate),
      });
    } catch (error) {
      console.error("Error adding deal lines:", error);
      res.status(500).json({ error: "Failed to add lines" });
    }
  });

  const partialCancelSchema = z.object({
    cancelCount: z.coerce.number().int().min(1, "해지 회선 수는 1 이상이어야 합니다."),
    reason: z.string().optional().default(""),
  });

  app.post("/api/deals/:id/partial-cancel", async (req, res) => {
    try {
      const parsed = partialCancelSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: parsed.error.errors[0]?.message || "잘못된 요청입니다." });
      }
      const { cancelCount, reason } = parsed.data;
      const normalizedReason = reason?.trim() || "";
      const deal = await storage.getDeal(req.params.id);
      if (!deal) {
        return res.status(404).json({ error: "거래를 찾을 수 없습니다." });
      }
      const currentLines = Math.max(deal.lineCount || 0, 0);
      const splitRows = await db
        .select({
          cancelledLineCount: deals.cancelledLineCount,
        })
        .from(deals)
        .where(eq(deals.parentDealId, deal.id));
      const currentCancelled =
        Math.max(deal.cancelledLineCount || 0, 0) +
        splitRows.reduce((sum, row) => sum + Math.max(Number(row.cancelledLineCount) || 0, 0), 0);
      const remainingLines = Math.max(currentLines - currentCancelled, 0);
      const newRemainingLineCount = Math.max(remainingLines - cancelCount, 0);
      if (cancelCount > remainingLines) {
        return res.status(400).json({ error: `현재 잔여 회선수(${remainingLines})보다 많이 해지할 수 없습니다.` });
      }
      if (cancelCount >= remainingLines) {
        return res.status(400).json({ error: "전체 잔여 회선수를 해지할 때는 해지 기능을 사용해주세요." });
      }

      const userId = (req.session as any)?.userId;
      let authorName = "시스템";
      if (userId) {
        const user = await storage.getUser(userId);
        if (user) authorName = user.name;
      }
      const cancelTz = await getSystemTimezone();
      const cancelDate = formatServerDate(new Date(), cancelTz);
      const reasonText = normalizedReason ? ` (사유: ${normalizedReason})` : "";
      await createDealTimelineAndSync({
        dealId: deal.id,
        content: `[부분해지] ${cancelDate} ${cancelCount}회선 해지 (${remainingLines} -> ${newRemainingLineCount})${reasonText}`,
        authorId: userId || null,
        authorName,
      });
      if (normalizedReason) {
        await ensureDealCancellationReasonTimeline({
          dealId: deal.id,
          reason: normalizedReason,
          reasonDate: new Date(),
          authorId: userId || null,
          authorName,
        });
      }

      const splitDeal = await storage.createDeal({
        parentDealId: deal.id,
        title: deal.title,
        customerId: deal.customerId,
        value: deal.value || 0,
        stage: "churned",
        probability: deal.probability || 0,
        expectedCloseDate: deal.expectedCloseDate,
        inboundDate: deal.inboundDate,
        contractStartDate: deal.contractStartDate,
        contractEndDate: deal.contractEndDate,
        churnDate: normalizeRegionalDealDate(new Date()),
        renewalDueDate: deal.renewalDueDate,
        contractStatus: "해지",
        notes: "",
        phone: deal.phone,
        email: deal.email,
        billingAccountNumber: deal.billingAccountNumber,
        companyName: deal.companyName,
        industry: deal.industry,
        telecomProvider: deal.telecomProvider,
        customerDisposition: deal.customerDisposition,
        customerTypeDetail: deal.customerTypeDetail,
        firstProgressStatus: deal.firstProgressStatus,
        secondProgressStatus: deal.secondProgressStatus,
        additionalProgressStatus: deal.additionalProgressStatus,
        acquisitionChannel: deal.acquisitionChannel,
        cancellationReason: normalizedReason || null,
        salesperson: deal.salesperson,
        preChurnStage: getRegionalDealStageLabel(deal.stage),
        lineCount: 0,
        cancelledLineCount: cancelCount,
        productId: deal.productId,
      });

      await createDealTimelineAndSync({
        dealId: splitDeal.id,
        content: `[부분해지] ${cancelDate} ${cancelCount}회선 해지${reasonText}`,
        authorId: userId || null,
        authorName,
      });
      if (normalizedReason) {
        await ensureDealCancellationReasonTimeline({
          dealId: splitDeal.id,
          reason: normalizedReason,
          reasonDate: new Date(),
          authorId: userId || null,
          authorName,
        });
      }

      res.json({
        ...splitDeal,
        contractStatus:
          normalizeRegionalDealContractStatus(splitDeal.contractStatus, splitDeal.stage) ||
          getRegionalDealStageLabel(splitDeal.stage),
        contractEndDate:
          normalizeRegionalDealDate(splitDeal.contractEndDate) ??
          addDaysToKoreanDate(splitDeal.contractStartDate, 1),
        churnDate: normalizeRegionalDealDate(splitDeal.churnDate),
      });
    } catch (error) {
      console.error("Error partial cancel deal:", error);
      res.status(500).json({ error: "Failed to partial cancel" });
    }
  });

  app.delete("/api/deals/:id", async (req, res) => {
    try {
      await storage.deleteDeal(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting deal:", error);
      res.status(500).json({ error: "Failed to delete deal" });
    }
  });

  app.get("/api/deals/:dealId/timelines", async (req, res) => {
    try {
      const timelines = await storage.getDealTimelines(req.params.dealId);
      res.json(timelines);
    } catch (error) {
      console.error("Error fetching timelines:", error);
      res.status(500).json({ error: "Failed to fetch timelines" });
    }
  });

  app.post("/api/deals/:dealId/timelines", async (req, res) => {
    try {
      const userId = (req.session as any)?.userId;
      let authorName = req.body.authorName || null;
      let authorId = null;
      if (userId) {
        const user = await storage.getUser(userId);
        if (user) {
          authorId = user.id;
          authorName = user.name;
        }
      }
      const parsed = insertDealTimelineSchema.safeParse({
        content: req.body.content,
        dealId: req.params.dealId,
        authorId,
        authorName,
      });
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid timeline data", details: parsed.error });
      }
      const timeline = await createDealTimelineAndSync(parsed.data);
      res.status(201).json(timeline);
    } catch (error) {
      console.error("Error creating timeline:", error);
      res.status(500).json({ error: "Failed to create timeline" });
    }
  });

  app.delete("/api/deals/timelines/:id", async (req, res) => {
    try {
      const timelineRows = await pool.query<{ deal_id: string }>(
        `SELECT deal_id FROM deal_timelines WHERE id = $1 LIMIT 1`,
        [req.params.id],
      );
      const dealId = timelineRows.rows[0]?.deal_id;

      await storage.deleteDealTimeline(req.params.id);
      if (dealId) {
        await syncDealNotesFromLatestTimeline(dealId);
      }
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting timeline:", error);
      res.status(500).json({ error: "Failed to delete timeline" });
    }
  });

  app.get("/api/activities", async (_req, res) => {
    try {
      const activities = await storage.getActivities();
      res.json(activities);
    } catch (error) {
      console.error("Error fetching activities:", error);
      res.status(500).json({ error: "Failed to fetch activities" });
    }
  });

  app.post("/api/activities", async (req, res) => {
    try {
      const parsed = insertActivitySchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid activity data", details: parsed.error });
      }
      const activity = await storage.createActivity(parsed.data);
      res.status(201).json(activity);
    } catch (error) {
      console.error("Error creating activity:", error);
      res.status(500).json({ error: "Failed to create activity" });
    }
  });

  app.delete("/api/activities/:id", async (req, res) => {
    try {
      await storage.deleteActivity(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting activity:", error);
      res.status(500).json({ error: "Failed to delete activity" });
    }
  });

  app.get("/api/payments", async (_req, res) => {
    try {
      const payments = await storage.getPayments();
      res.json(payments);
    } catch (error) {
      console.error("Error fetching payments:", error);
      res.status(500).json({ error: "Failed to fetch payments" });
    }
  });

  app.post("/api/payments", async (req, res) => {
    try {
      const parsed = insertPaymentSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payment data", details: parsed.error });
      }
      const payment = await storage.createPayment(parsed.data);
      res.status(201).json(payment);
    } catch (error) {
      console.error("Error creating payment:", error);
      res.status(500).json({ error: "Failed to create payment" });
    }
  });

  app.put("/api/payments/:id", async (req, res) => {
    try {
      const parsed = insertPaymentSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid payment data", details: parsed.error });
      }
      const payment = await storage.updatePayment(req.params.id, parsed.data);
      if (!payment) {
        return res.status(404).json({ error: "Payment not found" });
      }
      res.json(payment);
    } catch (error) {
      console.error("Error updating payment:", error);
      res.status(500).json({ error: "Failed to update payment" });
    }
  });

  app.delete("/api/payments/:id", async (req, res) => {
    try {
      await storage.deletePayment(req.params.id);
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting payment:", error);
      res.status(500).json({ error: "Failed to delete payment" });
    }
  });

  app.get("/api/system-logs", async (_req, res) => {
    try {
      const logs = await storage.getSystemLogs();
      res.json(logs);
    } catch (error) {
      console.error("Error fetching system logs:", error);
      res.status(500).json({ error: "Failed to fetch system logs" });
    }
  });

  app.post("/api/system-logs", async (req, res) => {
    try {
      const parsed = insertSystemLogSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid system log data", details: parsed.error });
      }
      const log = await storage.createSystemLog(parsed.data);
      res.status(201).json(log);
    } catch (error) {
      console.error("Error creating system log:", error);
      res.status(500).json({ error: "Failed to create system log" });
    }
  });

  app.get("/api/products", async (_req, res) => {
    try {
      const products = await storage.getProducts();
      res.json(products);
    } catch (error) {
      console.error("Error fetching products:", error);
      res.status(500).json({ error: "Failed to fetch products" });
    }
  });

  app.get("/api/product-rate-histories", async (req, res) => {
    try {
      const productId = toSingleString(req.query.productId as string | string[] | undefined);
      const histories = await storage.getProductRateHistories(productId || undefined);
      res.json(histories);
    } catch (error) {
      console.error("Error fetching product rate histories:", error);
      res.status(500).json({ error: "Failed to fetch product rate histories" });
    }
  });

  app.post("/api/admin/renewal-backfill", requireAuth, async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!currentUser || !PERMISSION_ADMIN_ROLES.includes(currentUser.role || "")) {
        return res.status(403).json({ error: "Unauthorized" });
      }
      const result = await backfillContractRenewalSchedule();
      res.json({ ok: true, ...result });
    } catch (error) {
      console.error("Error backfilling renewal schedule:", error);
      res.status(500).json({ error: "Failed to backfill renewal schedule" });
    }
  });

  app.get("/api/renewal-alerts", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!currentUser) return res.status(401).json({ error: "Login required" });
      const todayEnd = new Date();
      todayEnd.setHours(23, 59, 59, 999);
      const managerId = String(currentUser.id || "").trim() || null;
      const managerName = String(currentUser.name || "").trim();
      const result = await pool.query(
        `
          SELECT
            id,
            manager_id AS "managerId",
            manager_name AS "managerName",
            contract_number AS "contractNumber",
            customer_name AS "customerName",
            products,
            product_details_json AS "productDetailsJson",
            contract_date AS "contractDate",
            renewal_due_date AS "renewalDueDate",
            renewal_alert_disabled AS "renewalAlertDisabled",
            created_at AS "createdAt"
          FROM contracts
          WHERE renewal_due_date IS NOT NULL
            AND COALESCE(renewal_alert_disabled, false) = false
            AND COALESCE(contract_type, '') <> $4
            AND renewal_due_date <= $1
            AND (
              ($2::text IS NOT NULL AND manager_id = $2)
              OR lower(btrim(manager_name)) = lower(btrim($3))
            )
          ORDER BY renewal_due_date ASC, created_at ASC
        `,
        [todayEnd, managerId, managerName, CONTRACT_TYPE_REFUND],
      );
      res.json(result.rows);
    } catch (error) {
      console.error("Error fetching renewal alerts:", error);
      res.status(500).json({ error: "Failed to fetch renewal alerts" });
    }
  });

  app.post("/api/renewal-alerts/:contractId/disable", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!currentUser) return res.status(401).json({ error: "Login required" });
      const managerId = String(currentUser.id || "").trim() || null;
      const managerName = String(currentUser.name || "").trim();
      const result = await pool.query(
        `
          UPDATE contracts
          SET renewal_alert_disabled = true
          WHERE id = $1
            AND (
              ($2::text IS NOT NULL AND manager_id = $2)
              OR lower(btrim(manager_name)) = lower(btrim($3))
            )
          RETURNING contract_number
        `,
        [req.params.contractId, managerId, managerName],
      );
      if (result.rowCount === 0) {
        return res.status(404).json({ error: "Renewal alert not found" });
      }
      await writeSystemLog(req, {
        actionType: "renewal_alert_disable",
        action: "계약연장 알림 해제",
        details: `contractId=${req.params.contractId}, contractNumber=${result.rows[0]?.contract_number || ""}`,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error disabling renewal alert:", error);
      res.status(500).json({ error: "Failed to disable renewal alert" });
    }
  });

  app.post("/api/products", async (req, res) => {
    try {
      const body = { ...(req.body ?? {}) } as Record<string, unknown>;
      const effectiveFrom = parseEffectiveFrom(body.effectiveFrom) ?? new Date();
      delete body.effectiveFrom;

      const parsed = insertProductSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid product data", details: parsed.error });
      }

      const product = await storage.createProduct(parsed.data);

      const changedBy = req.session.userId
        ? (await storage.getUser(req.session.userId))?.name || req.session.userId
        : null;

      await storage.createProductRateHistory({
        productId: product.id,
        productName: product.name,
        effectiveFrom,
        unitPrice: Number(product.unitPrice) || 0,
        workCost: Number(product.workCost) || 0,
        baseDays: Number(product.baseDays) || 0,
        vatType: product.vatType || "부가세별도",
        worker: product.worker || null,
        changedBy,
      });

      res.status(201).json(product);
    } catch (error) {
      console.error("Error creating product:", error);
      res.status(500).json({ error: "Failed to create product" });
    }
  });

  app.put("/api/products/:id", async (req, res) => {
    try {
      const body = { ...(req.body ?? {}) } as Record<string, unknown>;
      const effectiveFrom = parseEffectiveFrom(body.effectiveFrom) ?? new Date();
      delete body.effectiveFrom;

      const parsed = insertProductSchema.partial().safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid product data", details: parsed.error });
      }

      const existingProduct = await storage.getProduct(req.params.id);
      if (!existingProduct) {
        return res.status(404).json({ error: "Product not found" });
      }

      const product = await storage.updateProduct(req.params.id, parsed.data);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }

      const shouldRecordHistory = (
        ["name", "unitPrice", "workCost", "baseDays", "vatType", "worker"] as const
      ).some((key) => Object.prototype.hasOwnProperty.call(parsed.data, key));

      if (shouldRecordHistory) {
        const changedBy = req.session.userId
          ? (await storage.getUser(req.session.userId))?.name || req.session.userId
          : null;

        await storage.createProductRateHistory({
          productId: product.id,
          productName: product.name,
          effectiveFrom,
          unitPrice: Number(product.unitPrice) || 0,
          workCost: Number(product.workCost) || 0,
          baseDays: Number(product.baseDays) || 0,
          vatType: product.vatType || "부가세별도",
          worker: product.worker || null,
          changedBy,
        });
      }

      await writeEntityAuditLog(
        req,
        "product",
        "update",
        product.name || req.params.id,
        `productId=${req.params.id}, fields=${Object.keys(parsed.data).join(",") || "-"}`,
      );

      res.json(product);
    } catch (error) {
      console.error("Error updating product:", error);
      res.status(500).json({ error: "Failed to update product" });
    }
  });

  app.delete("/api/products/:id", async (req, res) => {
    try {
      const product = await storage.getProduct(req.params.id);
      if (!product) {
        return res.status(404).json({ error: "Product not found" });
      }
      const contractCount = await getContractCountByProductReference(product.id, product.name);
      if (contractCount > 0) {
        return res.status(409).json({
          error: "계약에 연결된 상품은 삭제할 수 없습니다. 먼저 연결된 계약을 정리해주세요.",
          contractCount,
        });
      }

      await storage.deleteProduct(req.params.id);
      await writeEntityAuditLog(
        req,
        "product",
        "delete",
        product.name || req.params.id,
        `productId=${req.params.id}`,
      );
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting product:", error);
      res.status(500).json({ error: "Failed to delete product" });
    }
  });
  app.get("/api/contracts/paged", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "상담원은 계약관리에 접근할 수 없습니다." });
      }
      const page = toPositiveInt(req.query.page as string | string[] | undefined, 1);
      const pageSize = toPositiveInt(req.query.pageSize as string | string[] | undefined, 10);

      const search = toSingleString(req.query.search as string | string[] | undefined).trim();
      const contractNumber = toSingleString(req.query.contractNumber as string | string[] | undefined).trim();
      const managerName = toSingleString(req.query.manager as string | string[] | undefined).trim();
      const customerName = toSingleString(req.query.customer as string | string[] | undefined).trim();
      const productCategory = toSingleString(req.query.productCategory as string | string[] | undefined).trim();
      const paymentMethod = toSingleString(req.query.payment as string | string[] | undefined).trim();
      const sort = toSingleString(req.query.sort as string | string[] | undefined).trim();
      const startDate = parseKoreanRangeStart(req.query.startDate as string | string[] | undefined);
      const endDate = parseKoreanRangeEnd(req.query.endDate as string | string[] | undefined);

      const result = await storage.getContractsPaged({
        page,
        pageSize,
        search: contractNumber ? undefined : search || undefined,
        contractNumber: contractNumber || undefined,
        managerName: !contractNumber && managerName && managerName !== "all" ? managerName : undefined,
        customerName: !contractNumber && customerName && customerName !== "all" ? customerName : undefined,
        productCategory: !contractNumber && productCategory && productCategory !== "all" ? productCategory : undefined,
        paymentMethod: !contractNumber && paymentMethod && paymentMethod !== "all" ? paymentMethod : undefined,
        sort: sort === "contractDateAsc" || sort === "customerNameAsc" || sort === "contractDateDesc"
          ? sort
          : undefined,
        startDate: contractNumber ? undefined : startDate,
        endDate: contractNumber ? undefined : endDate,
      });

      res.json({
        ...result,
        items: result.items.map((item: any) => sanitizeFinancialContractRow(item, currentUser?.role)),
      });
    } catch (error) {
      console.error("Error fetching paged contracts:", error);
      res.status(500).json({ error: "Failed to fetch contracts" });
    }
  });

  app.get("/api/contracts", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (isCounselorPosition(currentUser?.role)) {
        return res.json([]);
      }
      const contracts = await storage.getContracts();
      res.json(contracts.map((contract) => sanitizeFinancialContractRow(contract as any, currentUser?.role)));
    } catch (error) {
      console.error("Error fetching contracts:", error);
      res.status(500).json({ error: "Failed to fetch contracts" });
    }
  });

  app.post("/api/contracts/bulk-mark-deposit-confirmed", async (req, res) => {
    try {
      const parsed = z.object({
        ids: z.array(z.string().trim().min(1)).min(1),
      }).safeParse(req.body);

      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid bulk deposit-confirmed payload", details: parsed.error });
      }

      const uniqueIds = Array.from(new Set(parsed.data.ids.map((id) => id.trim()).filter(Boolean)));
      let updatedCount = 0;

      for (const contractId of uniqueIds) {
        const existingContract = await storage.getContract(contractId);
        if (!existingContract) continue;

        const nextContract = await storage.updateContract(contractId, {
          paymentMethod: PAYMENT_METHOD_DEPOSIT_CONFIRMED,
          paymentConfirmed: true,
        });

        if (!nextContract) continue;

        const paymentPayload = buildPaymentPayloadFromContract({
          ...existingContract,
          ...nextContract,
          paymentMethod: PAYMENT_METHOD_DEPOSIT_CONFIRMED,
          paymentConfirmed: true,
        });

        const existingPayment = await storage.getPaymentByContractId(contractId);
        if (existingPayment) {
          await storage.updatePaymentByContractId(contractId, paymentPayload);
        } else {
          await storage.createPayment(paymentPayload);
        }

        await upsertAutoDepositConfirmationFromContract(
          { ...existingContract, ...nextContract, paymentMethod: PAYMENT_METHOD_DEPOSIT_CONFIRMED, paymentConfirmed: true },
          String((req.session as any).userId || "system"),
        );

        updatedCount += 1;
      }

      await writeSystemLog(req, {
        actionType: "contract_update",
        action: "계약 결제확인 일괄변경: 입금완료",
        details: `updated=${updatedCount}, ids=${uniqueIds.join(",")}`,
      });

      res.json({
        updatedCount,
        paymentMethod: PAYMENT_METHOD_DEPOSIT_CONFIRMED,
        paymentConfirmed: true,
      });
    } catch (error) {
      console.error("Error bulk marking contracts as deposit confirmed:", error);
      res.status(500).json({ error: "Failed to bulk mark contracts as deposit confirmed" });
    }
  });

  app.get("/api/contracts/:id/history", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (isCounselorPosition(currentUser?.role)) {
        return res.status(403).json({ error: "계약 이력을 조회할 권한이 없습니다." });
      }

      const contractId = toSingleString(req.params.id).trim();
      if (!contractId) {
        return res.status(400).json({ error: "Contract id is required." });
      }

      const logs = await storage.getSystemLogs();
      const detailNeedles = [
        `contractId=${contractId}`,
        `sourceContractId=${contractId}`,
        `refundContractId=${contractId}`,
      ];

      const history = logs
        .filter((log) => detailNeedles.some((needle) => String(log.details || "").includes(needle)))
        .sort((a, b) => {
          const left = new Date(a.createdAt as Date | string).getTime();
          const right = new Date(b.createdAt as Date | string).getTime();
          return (Number.isFinite(right) ? right : 0) - (Number.isFinite(left) ? left : 0);
        })
        .slice(0, 30);

      res.json(history);
    } catch (error) {
      console.error("Error fetching contract history:", error);
      res.status(500).json({ error: "Failed to fetch contract history" });
    }
  });

  app.get("/api/contracts/:id/refund-contracts", async (req, res) => {
    try {
      const contractId = toSingleString(req.params.id).trim();
      const itemId = toSingleString(req.query.itemId as string | string[] | undefined).trim();
      const refundContracts = await storage.getRefundContractsBySource(contractId, itemId || undefined);
      res.json(refundContracts);
    } catch (error) {
      console.error("Error fetching refund contracts:", error);
      res.status(500).json({ error: "Failed to fetch refund contracts" });
    }
  });

  app.post("/api/contracts/refund-entry", async (req, res) => {
    try {
      const body = { ...req.body };
      if (typeof body.refundDate === "string") {
        const normalizedRefundDate = normalizeToKoreanContractDate(body.refundDate);
        body.refundDate = normalizedRefundDate || new Date(body.refundDate);
      }
      body.amount = toWholeAmount(body.amount);
      body.targetAmount = toWholeAmount(body.targetAmount);

      const parsed = insertRefundSchema.parse({
        ...body,
        refundStatus: normalizeRefundStatus(body.refundStatus) ?? REFUND_STATUS_PENDING,
      });
      if (parsed.amount <= 0) {
        return res.status(400).json({ error: "Refund amount must be greater than zero." });
      }

      const contract = await storage.getContract(parsed.contractId);
      if (!contract) {
        return res.status(404).json({ error: "Contract not found." });
      }
      if (contract.contractType === CONTRACT_TYPE_REFUND) {
        return res.status(400).json({ error: "Refund contracts cannot be refunded again." });
      }
      const depositMatched = await hasContractDepositMatch(contract.id);
      const paymentConfirmed =
        contract.paymentConfirmed === true ||
        normalizeContractPaymentMethod(contract.paymentMethod) === PAYMENT_METHOD_DEPOSIT_CONFIRMED;
      if (!depositMatched && !paymentConfirmed) {
        return res.status(409).json({ error: "입금완료 계약만 환불할 수 있습니다." });
      }

      const targetAmount = Math.max(0, Number(parsed.targetAmount) || 0);
      const effectiveTargetAmount = targetAmount > 0 ? targetAmount : Math.max(0, Number(contract.cost) || 0);
      if (parsed.amount > effectiveTargetAmount) {
        return res.status(400).json({ error: "Refund amount cannot exceed selected row amount." });
      }

      const [existingRefunds, existingRefundContracts] = await Promise.all([
        storage.getRefundsByContract(parsed.contractId, parsed.itemId || undefined),
        storage.getRefundContractsBySource(parsed.contractId, parsed.itemId || undefined),
      ]);
      const totalRefunded = existingRefunds.reduce((sum, r) => sum + Math.max(Number(r.amount) || 0, 0), 0);
      const totalRefundContractAmount = existingRefundContracts.reduce(
        (sum, refundContract) => sum + Math.abs(Number(refundContract.cost) || 0),
        0,
      );
      const remainingCost = effectiveTargetAmount - totalRefunded - totalRefundContractAmount;
      if (parsed.amount > remainingCost) {
        return res.status(400).json({ error: "Refund amount cannot exceed remaining selected row amount." });
      }

      const refundContractPayload = insertContractSchema.parse(
        buildRefundContractPayload(contract, parsed, effectiveTargetAmount),
      );
      const refundContract = await storage.createContract(refundContractPayload);

      await writeSystemLog(req, {
        actionType: "contract_create",
        action: `계약 환불 등록: ${refundContract.contractNumber}`,
        details: `sourceContractId=${contract.id}, refundContractId=${refundContract.id}, amount=${parsed.amount}`,
      });

      res.status(201).json({
        success: true,
        sourceContractId: contract.id,
        refundContract,
      });
    } catch (error) {
      console.error("Error creating refund contract:", error);
      res.status(500).json({ error: "Failed to create refund contract" });
    }
  });

  app.post("/api/contracts", async (req, res) => {
    try {
      const body = { ...req.body };
      if (body.contractDate) {
        const normalizedContractDate = normalizeToKoreanContractDate(body.contractDate);
        if (normalizedContractDate) {
          body.contractDate = normalizedContractDate;
        } else if (typeof body.contractDate === "string") {
          body.contractDate = new Date(body.contractDate);
        }
      }
      body.renewalDueDate = normalizeOptionalContractDateField(body.renewalDueDate);
      const parsed = insertContractSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid contract data", details: parsed.error });
      }
      const normalizedContractData = normalizeContractQuantityPayload({ ...parsed.data });
      normalizedContractData.paymentMethod = normalizeContractPaymentMethod(normalizedContractData.paymentMethod);
      normalizedContractData.depositBank = normalizeContractDepositBank(
        normalizedContractData.depositBank,
        normalizedContractData.paymentMethod,
      );
      const [allProducts, allProductRateHistories] = await Promise.all([
        storage.getProducts(),
        storage.getProductRateHistories(),
      ]);
      const contractDataWithRenewal = resolveRenewalSchedulePayload(normalizedContractData, allProducts);
      const normalizedWorkCost = computeContractWorkCostFromProducts(
        contractDataWithRenewal,
        allProducts,
        allProductRateHistories,
      );
      const contract = await db.transaction(async (tx) => {
        const [createdContract] = await tx.insert(contracts).values({
          ...contractDataWithRenewal,
          contractName: null,
          workCost: normalizedWorkCost,
        }).returning();

        await tx.insert(payments).values(buildPaymentPayloadFromContract(createdContract));

        return createdContract;
      });

      await upsertAutoDepositConfirmationFromContract(
        contract as Contract,
        String((req.session as any).userId || "system"),
      );

      if (contract.customerId) {
        const linkedCustomer = await storage.getCustomer(contract.customerId);
        if (linkedCustomer && isCustomerLifecycleStage(linkedCustomer.lifecycleStage, "lead")) {
          await convertCustomerToCompany(contract.customerId);
          await writeEntityAuditLog(
            req,
            "customer",
            "update",
            linkedCustomer.name || contract.customerId,
            `customerId=${contract.customerId}, action=auto_convert_by_contract, contractId=${contract.id}`,
          );
        }
      }

      res.status(201).json(contract);
    } catch (error) {
      console.error("Error creating contract:", error);
      res.status(500).json({ error: "Failed to create contract" });
    }
  });

  app.put("/api/contracts/:id", async (req, res) => {
    try {
      const contractId = toSingleString(req.params.id);
      const body = { ...req.body };
      if (body.contractDate) {
        const normalizedContractDate = normalizeToKoreanContractDate(body.contractDate);
        if (normalizedContractDate) {
          body.contractDate = normalizedContractDate;
        } else if (typeof body.contractDate === "string") {
          body.contractDate = new Date(body.contractDate);
        }
      }
      if (Object.prototype.hasOwnProperty.call(body, "renewalDueDate")) {
        body.renewalDueDate = normalizeOptionalContractDateField(body.renewalDueDate);
      }
      const parsed = insertContractSchema.partial().safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid contract data", details: parsed.error });
      }
      const existingContract = await storage.getContract(contractId);
      if (!existingContract) {
        return res.status(404).json({ error: "Contract not found" });
      }

      const normalizedParsedData = normalizeContractQuantityPayload({ ...parsed.data });
      const updatePayload: Record<string, any> = {
        ...normalizedParsedData,
        contractName: null,
      };
      if (Object.prototype.hasOwnProperty.call(normalizedParsedData, "paymentMethod")) {
        updatePayload.paymentMethod = normalizeContractPaymentMethod(normalizedParsedData.paymentMethod);
      }
      if (
        Object.prototype.hasOwnProperty.call(normalizedParsedData, "depositBank") ||
        Object.prototype.hasOwnProperty.call(normalizedParsedData, "paymentMethod")
      ) {
        updatePayload.depositBank = normalizeContractDepositBank(
          Object.prototype.hasOwnProperty.call(normalizedParsedData, "depositBank")
            ? normalizedParsedData.depositBank
            : existingContract.depositBank,
          Object.prototype.hasOwnProperty.call(normalizedParsedData, "paymentMethod")
            ? updatePayload.paymentMethod
            : existingContract.paymentMethod,
        );
      }
      const shouldRecomputeWorkCost = ["products", "days", "quantity", "addQuantity", "extendQuantity", "workCost"]
        .some((key) => Object.prototype.hasOwnProperty.call(normalizedParsedData, key));
      let allProductsForUpdate: Array<{ name?: string | null; category?: string | null }> | undefined;
      if (shouldRecomputeWorkCost) {
        const [allProducts, allProductRateHistories] = await Promise.all([
          storage.getProducts(),
          storage.getProductRateHistories(),
        ]);
        allProductsForUpdate = allProducts;
        updatePayload.workCost = computeContractWorkCostFromProducts(
          { ...existingContract, ...normalizedParsedData },
          allProducts,
          allProductRateHistories,
        );
      }
      const renewalBasePayload = { ...existingContract, ...normalizedParsedData, ...updatePayload };
      const shouldRecomputeRenewalSchedule = [
        "contractDate",
        "products",
        "days",
        "productDetailsJson",
        "quantity",
        "addQuantity",
        "extendQuantity",
      ].some((key) => Object.prototype.hasOwnProperty.call(normalizedParsedData, key));
      const renewalDurationDays = getRenewalDurationDays(renewalBasePayload);
      if (
        existingContract.contractType !== CONTRACT_TYPE_REFUND &&
        (shouldRecomputeRenewalSchedule || !Object.prototype.hasOwnProperty.call(normalizedParsedData, "renewalDueDate"))
      ) {
        allProductsForUpdate = allProductsForUpdate || await storage.getProducts();
        const dueOffsetDays = getRenewalDueOffsetDays(renewalBasePayload, allProductsForUpdate);
        const dueDate = getRenewalDueDateForContract(renewalBasePayload.contractDate, dueOffsetDays);
        if (dueDate) updatePayload.renewalDueDate = dueDate;
      }
      if (existingContract.contractType !== CONTRACT_TYPE_REFUND && renewalDurationDays <= 1) {
        updatePayload.renewalAlertDisabled = true;
      }

      const contract = await db.transaction(async (tx) => {
        const [updatedContract] = await tx.update(contracts).set(updatePayload).where(eq(contracts.id, contractId)).returning();
        if (!updatedContract) {
          return undefined;
        }

        const existingPayment = await tx.select({ id: payments.id }).from(payments).where(eq(payments.contractId, contractId)).limit(1);
        const paymentPayload = buildPaymentPayloadFromContract(updatedContract);

        if (existingPayment.length > 0) {
          await tx.update(payments).set(paymentPayload).where(eq(payments.contractId, contractId));
        } else {
          await tx.insert(payments).values(paymentPayload);
        }

        return updatedContract;
      });
      if (!contract) {
        return res.status(404).json({ error: "Contract not found" });
      }

      await upsertAutoDepositConfirmationFromContract(
        contract as Contract,
        String((req.session as any).userId || "system"),
      );

      const changedFields = Object.keys(parsed.data || {});
      await writeSystemLog(req, {
        actionType: "contract_update",
        action: `계약 수정: ${contract.contractNumber || contractId}`,
        details: `contractId=${contractId}, fields=${changedFields.join(",") || "-"}`,
      });

      res.json(contract);
    } catch (error) {
      console.error("Error updating contract:", error);
      res.status(500).json({ error: "Failed to update contract" });
    }
  });

  app.delete("/api/contracts/:id", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (!currentUser || !isTeamLeadOrHigherRole(currentUser.role)) {
        return res.status(403).json({ error: "계약 삭제는 팀장 이상 권한만 가능합니다." });
      }

      const contractId = toSingleString(req.params.id);
      const contract = await storage.getContract(contractId);
      if (!contract) {
        return res.status(404).json({ error: "Contract not found" });
      }

      if (contract.contractType === CONTRACT_TYPE_REFUND) {
        return res.status(409).json({ error: "환불 계약은 환불관리의 철회 버튼으로만 삭제할 수 있습니다." });
      }

      const [refundContracts, refundRows, depositMatched] = await Promise.all([
        storage.getRefundContractsBySource(contractId),
        storage.getRefundsByContract(contractId),
        hasContractDepositMatch(contractId),
      ]);
      const paymentConfirmed =
        contract.paymentConfirmed === true ||
        normalizeContractPaymentMethod(contract.paymentMethod) === PAYMENT_METHOD_DEPOSIT_CONFIRMED;

      if (refundContracts.length > 0 || refundRows.length > 0) {
        return res.status(409).json({ error: "환불 내역이 매칭된 계약은 삭제할 수 없습니다. 환불관리에서 먼저 철회해주세요." });
      }
      if (depositMatched || paymentConfirmed) {
        return res.status(409).json({ error: "입금완료 또는 입금 매칭된 계약은 삭제할 수 없습니다." });
      }

      await storage.deleteContract(contractId);
      await writeEntityAuditLog(
        req,
        "contract",
        "delete",
        contract.contractNumber || contractId,
        `contractId=${contractId}, customerId=${contract.customerId || "-"}, products=${contract.products || "-"}`,
      );
      res.status(204).send();
    } catch (error) {
      console.error("Error deleting contract:", error);
      res.status(500).json({ error: "Failed to delete contract" });
    }
  });

  app.post("/api/contracts/:id/withdraw", async (req, res) => {
    try {
      const contractId = toSingleString(req.params.id);
      const contract = await storage.getContract(contractId);
      if (!contract) {
        return res.status(404).json({ error: "Contract not found" });
      }
      if (contract.contractType === CONTRACT_TYPE_REFUND) {
        return res.status(409).json({ error: "환불 계약은 계약 철회할 수 없습니다." });
      }
      if (isWithdrawnContract(contract)) {
        return res.status(409).json({ error: "이미 철회된 계약입니다." });
      }

      const depositMatched = await hasContractDepositMatch(contractId);
      const paymentMethod = normalizeContractPaymentMethod(contract.paymentMethod);
      if (depositMatched || contract.paymentConfirmed === true || paymentMethod !== PAYMENT_METHOD_BEFORE_DEPOSIT) {
        return res.status(409).json({ error: "입금예정 계약만 철회할 수 있습니다." });
      }

      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      const withdrawnAt = new Date();
      const withdrawnBy = currentUser?.name || "system";
      const updatedContract = await db.transaction(async (tx) => {
        const [updated] = await tx
          .update(contracts)
          .set({
            contractStatus: CONTRACT_STATUS_WITHDRAWN,
            withdrawnAt,
            withdrawnBy,
            paymentConfirmed: false,
            paymentMethod: PAYMENT_METHOD_WITHDRAWN,
          })
          .where(eq(contracts.id, contractId))
          .returning();

        await tx.update(payments).set({
          amount: 0,
          depositConfirmed: false,
          paymentMethod: PAYMENT_METHOD_WITHDRAWN,
          notes: contract.notes || null,
        }).where(eq(payments.contractId, contractId));

        return updated;
      });

      await writeSystemLog(req, {
        actionType: "contract_update",
        action: `계약 철회: ${contract.contractNumber || contractId}`,
        details: `contractId=${contractId}, withdrawnAt=${withdrawnAt.toISOString()}, withdrawnBy=${withdrawnBy}`,
      });

      res.json(updatedContract);
    } catch (error) {
      console.error("Error withdrawing contract:", error);
      res.status(500).json({ error: "Failed to withdraw contract" });
    }
  });

  app.get("/api/contracts-with-financials", async (req, res) => {
    try {
      const currentUser = req.session.userId ? await storage.getUser(req.session.userId) : null;
      if (isCounselorPosition(currentUser?.role)) {
        return res.json([]);
      }
      const data = await storage.getContractsWithFinancials();
      res.json(data.map((contract) => sanitizeFinancialContractRow(contract as any, currentUser?.role)));
    } catch (error) {
      console.error("Error fetching contracts with financials:", error);
      res.status(500).json({ error: "Failed to fetch contracts with financials" });
    }
  });

  app.get("/api/refunds", async (_req, res) => {
    try {
      const allRefunds = await storage.getAllRefunds();
      res.json(allRefunds);
    } catch (error) {
      if (isMissingPiiEncryptionKeyError(error)) {
        console.warn("Refund reference data skipped because PII_ENCRYPTION_KEY is not configured.");
        return res.json([]);
      }
      console.error("Error fetching all refunds:", error);
      res.status(500).json({ error: "Failed to fetch refunds" });
    }
  });

  app.put("/api/refunds/bulk/status", async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids)
        ? req.body.ids
            .map((value: unknown) => toSingleString(typeof value === "string" ? value : String(value ?? "")).trim())
            .filter(Boolean)
        : [];
      const refundStatus = normalizeRefundStatus(req.body?.refundStatus);

      if (ids.length === 0) {
        return res.status(400).json({ error: "Refund ids are required." });
      }

      if (!refundStatus) {
        return res.status(400).json({ error: "Refund status is required." });
      }

      const updatedCount = await storage.updateRefundStatuses(ids, refundStatus);
      res.json({
        success: true,
        updatedCount,
        refundStatus,
      });
    } catch (error) {
      console.error("Error updating refund statuses:", error);
      res.status(500).json({ error: "Failed to update refund statuses" });
    }
  });

  app.get("/api/refunds/:contractId", async (req, res) => {
    try {
      const itemId = toSingleString(req.query.itemId as string | string[] | undefined).trim();
      const refundList = await storage.getRefundsByContract(req.params.contractId, itemId || undefined);
      res.json(refundList);
    } catch (error) {
      if (isMissingPiiEncryptionKeyError(error)) {
        console.warn("Contract refund reference data skipped because PII_ENCRYPTION_KEY is not configured.");
        return res.json([]);
      }
      console.error("Error fetching refunds:", error);
      res.status(500).json({ error: "Failed to fetch refunds" });
    }
  });

  app.post("/api/refunds", async (req, res) => {
    try {
      const body = { ...req.body };
      if (typeof body.refundDate === "string") {
        body.refundDate = new Date(body.refundDate);
      }
      body.amount = toWholeAmount(body.amount);
      body.targetAmount = toWholeAmount(body.targetAmount);
      const parsed = insertRefundSchema.parse({
        ...body,
        refundStatus: normalizeRefundStatus(body.refundStatus) ?? REFUND_STATUS_PENDING,
      });
      if (parsed.amount <= 0) {
        return res.status(400).json({ error: "Refund amount must be greater than zero." });
      }
      const contract = await storage.getContract(parsed.contractId);
      if (!contract) {
        return res.status(404).json({ error: "Contract not found." });
      }
      const depositMatched = await hasContractDepositMatch(contract.id);
      const paymentConfirmed =
        contract.paymentConfirmed === true ||
        normalizeContractPaymentMethod(contract.paymentMethod) === PAYMENT_METHOD_DEPOSIT_CONFIRMED;
      if (!depositMatched && !paymentConfirmed) {
        return res.status(409).json({ error: "입금완료 계약만 환불할 수 있습니다." });
      }
      const targetAmount = Math.max(0, Number(parsed.targetAmount) || 0);
      const effectiveTargetAmount = targetAmount > 0 ? targetAmount : Math.max(0, Number(contract.cost) || 0);
      if (parsed.amount > effectiveTargetAmount) {
        return res.status(400).json({ error: "Refund amount cannot exceed selected row amount." });
      }
      const existingRefunds = await storage.getRefundsByContract(parsed.contractId, parsed.itemId || undefined);
      const totalRefunded = existingRefunds.reduce((sum, r) => sum + r.amount, 0);
      const remainingCost = effectiveTargetAmount - totalRefunded;
      if (parsed.amount > remainingCost) {
        return res.status(400).json({ error: "Refund amount cannot exceed remaining selected row amount." });
      }
      const previousPaymentMethod = await resolvePreviousFinancialBasePaymentMethod(parsed.contractId, contract);
      const refund = await storage.createRefund({
        ...parsed,
        previousPaymentMethod,
        refundStatus: normalizeRefundStatus(parsed.refundStatus) ?? REFUND_STATUS_PENDING,
      });
      await syncFinancialPaymentMethod(parsed.contractId);
      res.status(201).json(refund);
    } catch (error) {
      console.error("Error creating refund:", error);
      res.status(500).json({ error: "Failed to create refund" });
    }
  });

  app.delete("/api/refunds/:id", async (req, res) => {
    try {
      const refundId = toSingleString(req.params.id);
      const refund = await storage.getRefund(refundId);
      if (!refund) {
        return res.status(404).json({ error: "Refund not found" });
      }
      const matchedToDeposit = await hasDepositRefundMatch(refundId);

      await storage.deleteRefund(refundId);
      const paymentMethod = matchedToDeposit
        ? PAYMENT_METHOD_DEPOSIT_CONFIRMED
        : await syncFinancialPaymentMethod(refund.contractId, {
            deletedPreviousPaymentMethod: refund.previousPaymentMethod,
          });
      if (matchedToDeposit) {
        await Promise.all([
          storage.updateContract(refund.contractId, { paymentMethod }),
          storage.updatePaymentByContractId(refund.contractId, { paymentMethod }),
        ]);
      }

      res.json({
        success: true,
        id: refundId,
        contractId: refund.contractId,
        paymentMethod,
      });
    } catch (error) {
      console.error("Error deleting refund:", error);
      res.status(500).json({ error: "Failed to delete refund" });
    }
  });

  app.post("/api/refund-contracts/:id/withdraw", async (req, res) => {
    try {
      const refundContractId = toSingleString(req.params.id);
      const refundContract = await storage.getContract(refundContractId);
      if (!refundContract) {
        return res.status(404).json({ error: "Refund contract not found" });
      }
      if (refundContract.contractType !== CONTRACT_TYPE_REFUND) {
        return res.status(400).json({ error: "Only refund contracts can be withdrawn." });
      }
      const depositMatched = await hasContractDepositMatch(refundContractId);
      const paymentConfirmed =
        refundContract.paymentConfirmed === true ||
        normalizeContractPaymentMethod(refundContract.paymentMethod) === PAYMENT_METHOD_DEPOSIT_CONFIRMED;

      if (depositMatched || paymentConfirmed) {
        return res.status(409).json({ error: "입금완료 또는 입금 매칭된 환불 내역은 철회할 수 없습니다." });
      }

      await storage.deleteContract(refundContractId);

      await writeSystemLog(req, {
        actionType: "contract_delete",
        action: `환불 철회: ${refundContract.contractNumber || refundContractId}`,
        details: `refundContractId=${refundContractId}, sourceContractId=${refundContract.sourceContractId || "-"}`,
      });

      res.json({
        success: true,
        id: refundContractId,
        sourceContractId: refundContract.sourceContractId || null,
      });
    } catch (error) {
      console.error("Error withdrawing refund contract:", error);
      res.status(500).json({ error: "Failed to withdraw refund contract" });
    }
  });
  app.get("/api/permissions", async (_req, res) => {
    try {
      const permissions = await storage.getPagePermissions();
      res.json(permissions);
    } catch (error) {
      console.error("Error fetching permissions:", error);
      res.status(500).json({ error: "Failed to fetch permissions" });
    }
  });

  app.get("/api/permissions/:userId", async (req, res) => {
    try {
      const permissions = await storage.getPagePermissionsByUser(req.params.userId);
      res.json(permissions);
    } catch (error) {
      console.error("Error fetching user permissions:", error);
      res.status(500).json({ error: "Failed to fetch user permissions" });
    }
  });

  const setPermissionsSchema = z.object({
    pageKeys: z.array(z.string()),
  });

  app.put("/api/permissions/:userId", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "로그인이 필요합니다." });
      }
      const currentUser = await storage.getUser(req.session.userId);
      if (!(await hasPermissionSettingsAccess(currentUser))) {
        return res.status(403).json({ error: "권한 설정은 대표, 이사, 개발자 또는 권한설정 권한이 있는 사용자만 수정할 수 있습니다." });
      }
      const parsed = setPermissionsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid permissions data", details: parsed.error });
      }
      await storage.setPagePermissions(req.params.userId, filterAssignablePageKeys(parsed.data.pageKeys));
      res.json({ success: true });
    } catch (error) {
      console.error("Error setting permissions:", error);
      res.status(500).json({ error: "Failed to set permissions" });
    }
  });

  app.post("/api/permissions/apply-department-defaults/:userId", async (req, res) => {
    try {
      if (!req.session.userId) {
        return res.status(401).json({ error: "로그인이 필요합니다." });
      }
      const currentUser = await storage.getUser(req.session.userId);
      if (!(await hasPermissionSettingsAccess(currentUser))) {
        return res.status(403).json({ error: "권한 설정은 대표, 이사, 개발자 또는 권한설정 권한이 있는 사용자만 수정할 수 있습니다." });
      }
      const targetUser = await storage.getUser(req.params.userId);
      if (!targetUser) {
        return res.status(404).json({ error: "사용자를 찾을 수 없습니다." });
      }
      const role = targetUser.role;
      if (role && positionDefaultPages[role]) {
        const appliedPages = filterAssignablePageKeys(positionDefaultPages[role]);
        await storage.setPagePermissions(targetUser.id, appliedPages);
        res.json({ success: true, appliedPages });
      } else {
        res.status(400).json({ error: "해당 직책의 기본 권한이 설정되어 있지 않습니다." });
      }
    } catch (error) {
      console.error("Error applying department defaults:", error);
      res.status(500).json({ error: "Failed to apply department defaults" });
    }
  });

  app.get("/api/department-default-pages", async (_req, res) => {
    res.json(departmentDefaultPages);
  });

  // Deposits CRUD
  app.get("/api/deposits", autoLoginDev, requireAuth, async (_req, res) => {
    try {
      res.set({
        "Cache-Control": "no-store, no-cache, must-revalidate",
        Pragma: "no-cache",
        Expires: "0",
      });
      const allDeposits = await storage.getDeposits();
      const depositsWithRefundMatches = await Promise.all(
        allDeposits.map(async (deposit) => {
          const refundIds = await getDepositRefundMatchIds(deposit.id);
          return { ...deposit, refundIds };
        }),
      );
      res.json(depositsWithRefundMatches);
    } catch (error) {
      console.error("Error fetching deposits:", error);
      res.status(500).json({ error: "Failed to fetch deposits" });
    }
  });

  app.post("/api/deposits", autoLoginDev, requireAuth, requireDepositActionAllowed, async (req, res) => {
    try {
      const body = { ...req.body };
      if (typeof body.depositDate === "string") {
        body.depositDate = new Date(body.depositDate);
      }
      const parsed = insertDepositSchema.safeParse(body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid deposit data", details: parsed.error });
      }
      const created = await storage.createDeposit(parsed.data);
      await unmarkContractDepositDeleted(created.contractId);
      res.json(created);
    } catch (error) {
      console.error("Error creating deposit:", error);
      res.status(500).json({ error: "Failed to create deposit" });
    }
  });

  const upload = multer({ storage: multer.memoryStorage() });

  const normalizeDepositUploadKey = (value: unknown) =>
    String(value ?? "")
      .replace(/\uFEFF/g, "")
      .replace(/\s+/g, "")
      .trim()
      .toLowerCase();

  const getDepositUploadValue = (row: Record<string, unknown>, aliases: string[]) => {
    const normalizedEntries = new Map<string, unknown>();
    Object.entries(row || {}).forEach(([key, value]) => {
      normalizedEntries.set(normalizeDepositUploadKey(key), value);
    });

    for (const alias of aliases) {
      const value = normalizedEntries.get(normalizeDepositUploadKey(alias));
      if (value === undefined || value === null) continue;
      if (typeof value === "string" && value.trim() === "") continue;
      return value;
    }
    return undefined;
  };

  const getDepositUploadRows = (sheet: XLSX.WorkSheet) => {
    const matrix = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", raw: true }) as unknown[][];
    const headerRowIndex = matrix.findIndex((row) => {
      const keys = row.map((cell) => normalizeDepositUploadKey(cell));
      return keys.includes(normalizeDepositUploadKey("거래일시")) &&
        keys.includes(normalizeDepositUploadKey("보낸분/받는분")) &&
        keys.includes(normalizeDepositUploadKey("입금액(원)"));
    });

    if (headerRowIndex >= 0) {
      return {
        rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, {
          defval: "",
          raw: true,
          range: headerRowIndex,
        }),
        defaultDepositBank: "국민은행",
      };
    }

    return {
      rows: XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: "", raw: true }),
      defaultDepositBank: undefined,
    };
  };

  const parseDepositUploadDate = (rawValue: unknown) => {
    if (typeof rawValue === "number") {
      const excelEpochUtc = Date.UTC(1899, 11, 30);
      const millis = Math.round(rawValue * 24 * 60 * 60 * 1000);
      const parsed = new Date(excelEpochUtc + millis);
      if (!Number.isNaN(parsed.getTime())) return parsed;
    }

    if (rawValue instanceof Date && !Number.isNaN(rawValue.getTime())) {
      return rawValue;
    }

    const rawText = String(rawValue ?? "").trim();
    if (!rawText) return new Date();

    const normalizedText = rawText.replace(/[./]/g, "-");
    const dateTimeMatch = normalizedText.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s+(\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/);
    if (dateTimeMatch) {
      const [, year, month, day, hour = "0", minute = "0", second = "0"] = dateTimeMatch;
      const parsedDate = new Date(
        Number(year),
        Number(month) - 1,
        Number(day),
        Number(hour),
        Number(minute),
        Number(second),
      );
      if (!Number.isNaN(parsedDate.getTime())) return parsedDate;
    }

    const parsed = new Date(normalizedText);
    if (!Number.isNaN(parsed.getTime())) return parsed;

    return new Date();
  };

  app.post("/api/deposits/upload", autoLoginDev, requireAuth, requireDepositActionAllowed, upload.single("file"), async (req, res) => {
    try {
      if (!req.file) {
        return res.status(400).json({ error: "파일이 없습니다." });
      }
      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });
      const sheetName = workbook.SheetNames[0];
      const sheet = workbook.Sheets[sheetName];
      const { rows, defaultDepositBank } = getDepositUploadRows(sheet);

      const depositsToCreate = rows
        .map((row) => {
          const rawDate = getDepositUploadValue(row, [
            "거래일시",
            "입금일자",
            "입금일",
            "날짜",
            "일자",
            "date",
            "depositDate",
          ]);
          const rawDepositorName = getDepositUploadValue(row, [
            "보낸분/받는분",
            "입금자명",
            "입금자",
            "예금주",
            "이름",
            "고객명",
            "depositor",
            "depositorName",
          ]);
          const rawDepositAmount = getDepositUploadValue(row, [
            "입금액(원)",
            "입금액",
            "입금금액",
            "입금액",
            "금액",
            "amount",
            "depositAmount",
          ]);
          const rawDepositBank = getDepositUploadValue(row, [
            "입금은행",
            "은행",
            "bank",
            "depositBank",
          ]);
          const rawNotes = getDepositUploadValue(row, ["비고", "메모", "notes", "note"]);

          const depositorName = String(rawDepositorName ?? "").trim();
          const depositAmount =
            Number(String(rawDepositAmount ?? "0").replace(/[,원\s]/g, "")) || 0;

          if (!depositorName && depositAmount <= 0) {
            return null;
          }

          return {
            depositDate: parseDepositUploadDate(rawDate),
            depositorName,
            depositAmount,
            depositBank: String(rawDepositBank ?? "").trim() || defaultDepositBank || "하나",
            notes: String(rawNotes ?? "").trim() || null,
            confirmedAmount: 0,
            contractId: null,
            confirmedBy: null,
            confirmedAt: null,
          };
        })
        .filter((deposit): deposit is NonNullable<typeof deposit> => Boolean(deposit?.depositorName));

      if (depositsToCreate.length === 0) {
        return res.status(400).json({
          error: "업로드 가능한 입금 행을 찾지 못했습니다. 입금자명/입금금액 열 이름을 확인해주세요.",
        });
      }

      const created = [];
      for (const depositToCreate of depositsToCreate) {
        const createdDeposit = await storage.createDeposit(depositToCreate);
        created.push(createdDeposit);
      }
      await writeSystemLog(req, {
        actionType: "excel_upload",
        action: "입금완료 엑셀 업로드",
        details: `file=${req.file.originalname}, rows=${rows.length}, imported=${created.length}`,
      });
      res.json({ count: created.length, deposits: created });
    } catch (error) {
      console.error("Error uploading deposits:", error);
      res.status(500).json({ error: "입금 업로드에 실패했습니다." });
    }
  });
  app.put("/api/deposits/:id", autoLoginDev, requireAuth, async (req, res) => {
    try {
      const { contractIds, refundIds, confirmedAmount, depositDate, depositorName, depositAmount, depositBank, notes } = req.body;
      const isDetailEditRequest =
        depositDate !== undefined ||
        depositorName !== undefined ||
        depositAmount !== undefined ||
        depositBank !== undefined ||
        notes !== undefined;

      if (isDetailEditRequest) {
        const currentUser = await storage.getUser(req.session.userId!);
        const userDepartment = String(currentUser?.department || "").trim();
        const userRole = String(currentUser?.role || "").trim();
        const canManageDeposits =
          DEPOSIT_ACTION_ALLOWED_DEPARTMENTS.has(userDepartment) ||
          PERMISSION_ADMIN_ROLES.includes(userRole);
        if (!canManageDeposits) {
          return res.status(403).json({ error: "입금완료 등록, 엑셀 업로드, 수정, 삭제는 경영지원팀 또는 대표이사/총괄이사/개발자만 가능합니다." });
        }

        const updateData: any = {};
        if (depositDate !== undefined) {
          const parsedDate = new Date(depositDate);
          if (isNaN(parsedDate.getTime())) {
            return res.status(400).json({ error: "유효하지 않은 날짜 형식입니다." });
          }
          updateData.depositDate = parsedDate;
        }
        if (depositorName !== undefined) {
          if (typeof depositorName !== "string" || !depositorName.trim()) {
            return res.status(400).json({ error: "입금자명을 입력해주세요." });
          }
          updateData.depositorName = depositorName.trim();
        }
        if (depositAmount !== undefined) {
          const parsedAmount = Number(depositAmount);
          if (isNaN(parsedAmount) || parsedAmount < 0) {
            return res.status(400).json({ error: "유효하지 않은 금액입니다." });
          }
          updateData.depositAmount = Math.round(parsedAmount);
        }
        if (depositBank !== undefined) {
          updateData.depositBank = depositBank;
        }
        if (notes !== undefined) {
          updateData.notes = notes;
        }
        const updated = await storage.updateDeposit(req.params.id as string, updateData);
        if (!updated) {
          return res.status(404).json({ error: "Deposit not found" });
        }
        await unmarkContractDepositDeleted(updated.contractId);
        if (!contractIds && !refundIds && !req.body.contractId) {
          return res.json(updated);
        }
      }

      const depositId = req.params.id as string;
      const normalizedContractIds = Array.isArray(contractIds)
        ? Array.from(new Set(contractIds.map((id: unknown) => String(id || "").trim()).filter(Boolean)))
        : req.body.contractId
          ? [String(req.body.contractId).trim()].filter(Boolean)
          : [];
      const normalizedRefundIds = Array.isArray(refundIds)
        ? Array.from(new Set(refundIds.map((id: unknown) => String(id || "").trim()).filter(Boolean)))
        : [];

      let totalContractCost = 0;
      for (const contractId of normalizedContractIds) {
        const contract = await storage.getContract(contractId);
        if (!contract) continue;
        totalContractCost += getDepositMatchContractAmount(contract);
      }

      const selectedRefundRows = (
        await Promise.all(normalizedRefundIds.map((refundId) => storage.getRefund(refundId)))
      ).filter((refund): refund is NonNullable<typeof refund> => {
        return Boolean(refund);
      });
      const refundContracts = await Promise.all(
        selectedRefundRows.map((refund) => storage.getContract(refund.contractId)),
      );
      const totalRefundOffsetAmount = selectedRefundRows.reduce((sum, refund, index) => {
        return sum + getDepositMatchRefundAmountWithVat(refundContracts[index], refund);
      }, 0);
      const netMatchedAmount = Math.max(totalContractCost - totalRefundOffsetAmount, 0);
      const depositCoversAll = (Number(confirmedAmount) || 0) >= netMatchedAmount;

      for (const contractId of normalizedContractIds) {
        await storage.updateContract(contractId, {
          paymentMethod: PAYMENT_METHOD_DEPOSIT_CONFIRMED,
          paymentConfirmed: depositCoversAll,
        });
      }

      await replaceDepositRefundMatches(
        depositId,
        selectedRefundRows.map((refund) => refund.id),
      );

      const firstContractId =
        normalizedContractIds[0] ||
        selectedRefundRows[0]?.contractId ||
        null;
      const updated = await storage.updateDeposit(depositId, {
        confirmedAmount: confirmedAmount || 0,
        totalContractAmount: netMatchedAmount,
        contractId: firstContractId,
        confirmedAt: new Date(),
        confirmedBy: (req.session as any).userId || "system",
      } as any);
      if (!updated) {
        return res.status(404).json({ error: "Deposit not found" });
      }
      await unmarkContractDepositDeleted(firstContractId);
      res.json(updated);
    } catch (error) {
      console.error("Error updating deposit:", error);
      res.status(500).json({ error: "Failed to update deposit" });
    }
  });

  app.delete("/api/deposits/:id", autoLoginDev, requireAuth, requireDepositActionAllowed, async (req, res) => {
    try {
      const depositId = req.params.id as string;
      const blockers = await getDepositDeletionBlockers(depositId);
      if (!blockers.deposit) {
        return res.status(404).json({ error: "Deposit not found" });
      }
      if (hasDepositDeletionBlockers(blockers)) {
        return sendDepositDeletionBlocked(res, blockers);
      }

      const existing = blockers.deposit;
      const matchedRefundIds = await getDepositRefundMatchIds(depositId);
      if (matchedRefundIds.length > 0) {
        await clearDepositRefundMatches(depositId);
      }
      await markContractDepositDeleted(existing?.contractId);
      if (existing?.contractId) {
        await storage.updateContract(existing.contractId, {
          paymentMethod: "입금예정",
          paymentConfirmed: false,
          depositBank: null,
        });
      }
      await storage.deleteDeposit(depositId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting deposit:", error);
      res.status(500).json({ error: "Failed to delete deposit" });
    }
  });

  app.post("/api/deposits/bulk-delete", autoLoginDev, requireAuth, requireDepositActionAllowed, async (req, res) => {
    try {
      const { ids } = req.body;
      if (!Array.isArray(ids) || ids.length === 0) {
        return res.status(400).json({ error: "삭제할 항목을 선택해주세요." });
      }
      const deleteChecks = await Promise.all(ids.map((id) => getDepositDeletionBlockers(String(id || "").trim())));
      const blocked = deleteChecks.filter(hasDepositDeletionBlockers);
      if (blocked.length > 0) {
        return res.status(409).json({
          error: "환불 처리된 계약의 입금확인은 삭제할 수 없습니다. 환불 철회 후 입금확인을 삭제해주세요.",
          blockedDepositIds: blocked.map((blocker) => blocker.deposit?.id).filter(Boolean),
          refundIds: Array.from(new Set(blocked.flatMap((blocker) => blocker.refundIds))),
          refundContractIds: Array.from(new Set(blocked.flatMap((blocker) => blocker.refundContractIds))),
        });
      }

      const deletedIds: string[] = [];
      for (const id of ids) {
        const existing = await storage.getDeposit(id);
        if (!existing) continue;
        const matchedRefundIds = await getDepositRefundMatchIds(id);
        if (matchedRefundIds.length > 0) {
          await clearDepositRefundMatches(id);
        }
        await markContractDepositDeleted(existing.contractId);
        if (existing.contractId) {
          await storage.updateContract(existing.contractId, {
            paymentMethod: "입금예정",
            paymentConfirmed: false,
            depositBank: null,
          });
        }
        await storage.deleteDeposit(id);
        deletedIds.push(id);
      }
      res.json({ success: true, deletedCount: deletedIds.length, deletedIds });
    } catch (error) {
      console.error("Error bulk deleting deposits:", error);
      res.status(500).json({ error: "일괄 삭제에 실패했습니다." });
    }
  });

  app.get("/api/deposits/contracts-by-department", autoLoginDev, requireAuth, async (req, res) => {
    try {
      const user = await storage.getUser(req.session.userId!);
      if (!user) return res.status(401).json({ error: "User not found" });
      const allContracts = await storage.getContracts();
      const matchableContracts = allContracts.filter((contract) => isMatchableDepositContract(contract));
      res.json(matchableContracts);
    } catch (error) {
      console.error("Error fetching contracts by department:", error);
      res.status(500).json({ error: "Failed to fetch contracts" });
    }
  });

  app.get("/api/sales-analytics", autoLoginDev, requireAuth, async (req, res) => {
    try {
      const { startDate, endDate, managerName: managerNameFilter, customerName: customerNameFilter, productFilter, departmentFilter } = req.query;
      const contracts = await storage.getContractsWithFinancials();
      const users = await storage.getUsers();
      const products = await storage.getProducts();
      const customers = await storage.getCustomers();
      const allRefunds = await storage.getAllRefunds();

      const currentUser = await storage.getUser(req.session.userId!);
      if (!currentUser) {
        return res.status(401).json({ error: "User not found" });
      }
      const isExecutive = PERMISSION_ADMIN_ROLES.includes(currentUser.role || "");
      const isManager = isManagerPosition(currentUser.role);
      const managerNameValue = normalizeText(toSingleString(managerNameFilter as string | string[] | undefined));
      const customerNameValue = normalizeText(toSingleString(customerNameFilter as string | string[] | undefined));
      const productFilterValue = normalizeText(toSingleString(productFilter as string | string[] | undefined));
      const departmentFilterValue = normalizeText(toSingleString(departmentFilter as string | string[] | undefined));

      const normalizeProductKey = (value: unknown) => normalizeText(value).replace(/\s+/g, "");
      const getBaseProductName = (value: unknown) => normalizeText(value).replace(/\s*\([^)]*\)\s*$/, "").trim();
      const getBaseProductKey = (value: unknown) => normalizeProductKey(getBaseProductName(value));
      const productByName = new Map(
        products
          .map((product) => [normalizeText(product.name), product] as const)
          .filter(([name]) => !!name),
      );
      const productByBaseName = new Map(
        products
          .map((product) => [getBaseProductKey(product.name), product] as const)
          .filter(([name]) => !!name),
      );
      const regionalProductNameSet = new Set(
        products
          .filter((product) => isRegionalKeyword(product.category) || isRegionalKeyword(product.name))
          .map((product) => normalizeText(product.name))
          .filter(Boolean),
      );
      const productById = new Map(
        products.map((product) => [String(product.id), product] as const),
      );
      const customersById = new Map(
        customers.map((customer) => [String(customer.id), customer] as const),
      );
      const contractsByCustomerId = new Map<string, typeof contracts>();
      contracts.forEach((contract) => {
        const customerId = normalizeText(contract.customerId);
        if (!customerId) return;
        const existing = contractsByCustomerId.get(customerId) || [];
        existing.push(contract);
        contractsByCustomerId.set(customerId, existing);
      });
      const regionalProductNameSetEnhanced = new Set([
        ...Array.from(regionalProductNameSet),
        ...products
          .filter((product) => isRegionalKeyword(product.category) || isRegionalKeyword(product.name))
          .map((product) => normalizeText(product.name))
          .filter(Boolean),
      ]);
      const regionalProductIdSet = new Set(
        products
          .filter((product) => isRegionalKeyword(product.category) || isRegionalKeyword(product.name))
          .map((product) => String(product.id)),
      );
      const parseContractProductNames = (value: string | null | undefined) =>
        String(value || "")
          .split(",")
          .map((name) => normalizeText(name))
          .filter(Boolean);
      const parseAnalyticsProductDetails = (rawValue: unknown) => {
        if (typeof rawValue !== "string" || !rawValue.trim()) return [] as Array<{
          productName: string;
          days: number;
          addQuantity: number;
          extendQuantity: number;
        }>;
        try {
          const parsed = JSON.parse(rawValue);
          if (!Array.isArray(parsed)) return [];
          return parsed
            .filter((item): item is Record<string, unknown> => !!item && typeof item === "object")
            .map((item) => ({
              productName: normalizeText(item.productName),
              days: Math.max(Number(item.days) || 0, 0),
              addQuantity: Math.max(Number(item.addQuantity) || 0, 0),
              extendQuantity: Math.max(Number(item.extendQuantity) || 0, 0),
            }))
            .filter((item) => !!item.productName);
        } catch {
          return [];
        }
      };
      const getContractAnalyticsProductNames = (contract: {
        products: string | null | undefined;
        productDetailsJson?: string | null | undefined;
      }) => {
        const detailProductNames = parseAnalyticsProductDetails(contract.productDetailsJson)
          .map((item) => item.productName)
          .filter(Boolean);
        return Array.from(new Set([...detailProductNames, ...parseContractProductNames(contract.products)]));
      };
      const hasSlotContractNumberHint = (contract: { contractNumber?: string | null | undefined }) => {
        const contractNumber = normalizeText(contract.contractNumber).toUpperCase();
        return contractNumber.includes("SLOT") || contractNumber.includes("SLT");
      };
      const hasViralContractNumberHint = (contract: { contractNumber?: string | null | undefined }) => {
        const contractNumber = normalizeText(contract.contractNumber).toUpperCase();
        return contractNumber.includes("VIRAL");
      };
      const contractHasRegionalProduct = (contract: { products: string | null | undefined }) => {
        const productNames = parseContractProductNames(contract.products);
        return productNames.some((name) => {
          if (regionalProductNameSetEnhanced.has(name)) return true;
          if (isRegionalKeyword(name)) return true;
          const matched = productByName.get(name);
          return !!matched && (isRegionalKeyword(matched.category) || isRegionalKeyword(matched.name));
        });
      };
      const contractMatchesProductFilter = (
        contract: { products: string | null | undefined },
        targetProductName: string,
      ) => {
        const normalizedTarget = normalizeText(targetProductName);
        if (!normalizedTarget) return false;
        return parseContractProductNames(contract.products).includes(normalizedTarget);
      };
      const usersById = new Map(users.map((user) => [String(user.id), user] as const));
      const usersByName = new Map(
        users
          .map((user) => [normalizeText(user.name), user] as const)
          .filter(([name]) => !!name),
      );
      const resolveContractDepartment = (
        contract: { managerId: string | null; managerName: string | null; products: string | null },
      ) => {
        return contractHasRegionalProduct(contract) ? REGIONAL_DEPARTMENT : MARKETING_DEPARTMENT;
      };
      const resolveDealDepartment = (
        deal: {
          productId: string | null;
          productName?: string | null;
          customerId?: string | null;
          billingAccountNumber?: string | null;
          companyName?: string | null;
          contractStatus?: string | null;
          lineCount?: number | null;
          cancelledLineCount?: number | null;
        },
      ) => {
        const product = productById.get(String(deal.productId || ""));
        if (product && (regionalProductIdSet.has(String(product.id)) || isRegionalKeyword(product.category) || isRegionalKeyword(product.name))) {
          return REGIONAL_DEPARTMENT;
        }
        if (isRegionalKeyword(deal.productName)) return REGIONAL_DEPARTMENT;
        const normalizedDealStatus = normalizeRegionalDealContractStatus(deal.contractStatus);
        const hasRegionalBusinessKey =
          !!normalizeText(deal.billingAccountNumber) ||
          !!normalizeText(deal.companyName);
        const hasRegionalLineData =
          Math.max(Number(deal.lineCount) || 0, 0) > 0 ||
          Math.max(Number(deal.cancelledLineCount) || 0, 0) > 0;
        if (
          (normalizedDealStatus === "인입" || normalizedDealStatus === "개통" || normalizedDealStatus === "해지") &&
          (hasRegionalBusinessKey || hasRegionalLineData)
        ) {
          return REGIONAL_DEPARTMENT;
        }
        if (deal.customerId) {
          const matchedContract = contracts.find((contract) => contract.customerId === deal.customerId);
          if (matchedContract) return resolveContractDepartment(matchedContract);
        }
        return MARKETING_DEPARTMENT;
      };
      const hasTeamUsers = users.some((user) => {
        const dept = normalizeText(user.department);
        return dept === REGIONAL_DEPARTMENT || dept === MARKETING_DEPARTMENT;
      });
      const hasManagerMapping = contracts.some((contract) =>
        users.some((user) =>
          (contract.managerId && String(user.id) === String(contract.managerId)) ||
          normalizeText(user.name) === normalizeText(contract.managerName)
        )
      );
      const canApplyDepartmentSplit = regionalProductIdSet.size > 0 || (hasTeamUsers && hasManagerMapping);

      let filtered = contracts.filter((contract) => !isWithdrawnContract(contract));

      if (isManager) {
        filtered = filtered.filter((contract) => isOwnManagedRecord(currentUser, contract));
      } else if (!isExecutive) {
        const userDepartment = normalizeText(currentUser.department);
        if (canApplyDepartmentSplit && (userDepartment === REGIONAL_DEPARTMENT || userDepartment === MARKETING_DEPARTMENT)) {
          filtered = filtered.filter((contract) => resolveContractDepartment(contract) === userDepartment);
        } else if (userDepartment && userDepartment !== REGIONAL_DEPARTMENT && userDepartment !== MARKETING_DEPARTMENT) {
          const sameTeamUsers = users.filter((user) => normalizeText(user.department) === userDepartment);
          const sameTeamIds = new Set(sameTeamUsers.map((user) => String(user.id)));
          const sameTeamNames = new Set(sameTeamUsers.map((user) => normalizeText(user.name)).filter(Boolean));
          filtered = filtered.filter((contract) =>
            (contract.managerId && sameTeamIds.has(String(contract.managerId))) ||
            (normalizeText(contract.managerName) && sameTeamNames.has(normalizeText(contract.managerName)))
          );
        }
      }

      const accessFilteredContracts = filtered;
      const matchesContractSelectionFilters = (contract: typeof accessFilteredContracts[number]) => {
        if (managerNameValue && managerNameValue !== "all" && normalizeText(contract.managerName) !== managerNameValue) {
          return false;
        }
        if (customerNameValue && customerNameValue !== "all" && normalizeText(contract.customerName) !== customerNameValue) {
          return false;
        }
        if (productFilterValue && productFilterValue !== "all" && !contractMatchesProductFilter(contract, productFilterValue)) {
          return false;
        }
        if (canApplyDepartmentSplit && departmentFilterValue && departmentFilterValue !== "all") {
          const contractDepartment = resolveContractDepartment(contract);
          if (departmentFilterValue === REGIONAL_DEPARTMENT || departmentFilterValue === MARKETING_DEPARTMENT) {
            return contractDepartment === departmentFilterValue;
          }
          return normalizeText(contractDepartment) === departmentFilterValue;
        }
        return true;
      };

      const filteredWithoutDate = accessFilteredContracts.filter(matchesContractSelectionFilters);
      filtered = filteredWithoutDate;
      const startDateValue = toSingleString(startDate as string | string[] | undefined);
      const endDateValue = toSingleString(endDate as string | string[] | undefined);
      if (startDateValue || endDateValue) {
        filtered = filtered.filter((c) =>
          isWithinKoreanDateRange(c.contractDate, startDateValue || undefined, endDateValue || undefined),
        );
      }

      const refundMatchesSelectionFilters = (
        refund: (typeof allRefunds)[number],
        options?: { ignoreDate?: boolean },
      ) => {
        if (!options?.ignoreDate && !isWithinKoreanDateRange(refund.refundDate, startDateValue || undefined, endDateValue || undefined)) {
          return false;
        }
        if (managerNameValue && managerNameValue !== "all" && normalizeText(refund.managerName) !== managerNameValue) {
          return false;
        }
        if (isManager && normalizeText(refund.managerName) !== normalizeText(currentUser.name)) {
          return false;
        }
        if (customerNameValue && customerNameValue !== "all" && normalizeText(refund.customerName) !== customerNameValue) {
          return false;
        }
        const refundProductNames = [
          normalizeText(refund.productName),
          ...parseContractProductNames(refund.products),
        ].filter(Boolean);
        if (
          productFilterValue &&
          productFilterValue !== "all" &&
          !refundProductNames.some((name) => normalizeText(name) === productFilterValue)
        ) {
          return false;
        }
        const isRegionalRefund = refundProductNames.some((name) => contractHasRegionalProduct({ products: name }));
        if (departmentFilterValue === REGIONAL_DEPARTMENT && !isRegionalRefund) return false;
        if (departmentFilterValue === MARKETING_DEPARTMENT && isRegionalRefund) return false;
        if (!isExecutive && normalizeText(currentUser.department) === REGIONAL_DEPARTMENT && !isRegionalRefund) return false;
        if (!isExecutive && normalizeText(currentUser.department) === MARKETING_DEPARTMENT && isRegionalRefund) return false;
        return true;
      };
      const filteredRefunds = allRefunds.filter((refund) => refundMatchesSelectionFilters(refund));

      const totalSales = filtered.reduce((sum, contract) => sum + getGrossSalesAmount(contract), 0);
      const totalRefunds = filteredRefunds.reduce((sum, refund) => sum + Math.max(Number(refund.amount) || 0, 0), 0);
      const netSales = totalSales - totalRefunds;
      const contractCount = filtered.length;
      const avgDealAmount = contractCount > 0 ? Math.round(totalSales / contractCount) : 0;
      const confirmedCount = filtered.filter(c => c.paymentConfirmed).length;
      const confirmRate = contractCount > 0 ? Math.round((confirmedCount / contractCount) * 1000) / 10 : 0;

      const monthlyMap: Record<string, { sales: number; refunds: number; count: number }> = {};
      const ensureMonthlyBucket = (key: string) => {
        if (!monthlyMap[key]) monthlyMap[key] = { sales: 0, refunds: 0, count: 0 };
        return monthlyMap[key];
      };
      filtered.forEach(c => {
        const key = getKoreanYearMonthKey(c.contractDate);
        if (!key) return;
        const bucket = ensureMonthlyBucket(key);
        bucket.sales += getGrossSalesAmount(c);
        bucket.count += 1;
      });
      filteredRefunds.forEach((refund) => {
        const key = getKoreanYearMonthKey(refund.refundDate);
        if (!key) return;
        const bucket = ensureMonthlyBucket(key);
        bucket.refunds += Math.max(Number(refund.amount) || 0, 0);
      });
      const monthlyData = Object.entries(monthlyMap)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([key, val]) => ({
          month: `${parseInt(key.split("-")[1], 10)}월`,
          yearMonth: key,
          매출: val.sales,
          환불: val.refunds,
          순매출: val.sales - val.refunds,
          건수: val.count,
        }));

      const productMap: Record<string, { sales: number; count: number }> = {};
      filtered.forEach(c => {
        const pName = c.products || "기타";
        if (!productMap[pName]) productMap[pName] = { sales: 0, count: 0 };
        productMap[pName].sales += getGrossSalesAmount(c);
        productMap[pName].count += 1;
      });
      const colors = ["#135bec", "#3b82f6", "#60a5fa", "#93c5fd", "#bfdbfe", "#818cf8", "#a78bfa"];
      const productData = Object.entries(productMap)
        .sort(([, a], [, b]) => b.sales - a.sales)
        .map(([name, val], i) => ({
          name,
          value: totalSales > 0 ? Math.round((val.sales / totalSales) * 1000) / 10 : 0,
          sales: val.sales,
          count: val.count,
          color: colors[i % colors.length],
        }));

      const marketingProductMap: Record<string, { sales: number; count: number }> = {};
      filtered.forEach(c => {
        const pName = c.products || "기타";
        if (resolveContractDepartment(c) === REGIONAL_DEPARTMENT) return;
        if (!marketingProductMap[pName]) marketingProductMap[pName] = { sales: 0, count: 0 };
        marketingProductMap[pName].sales += getGrossSalesAmount(c);
        marketingProductMap[pName].count += 1;
      });
      const marketingTotalSales = Object.values(marketingProductMap).reduce((s, v) => s + v.sales, 0);
      const marketingProductData = Object.entries(marketingProductMap)
        .sort(([, a], [, b]) => b.sales - a.sales)
        .map(([name, val], i) => ({
          name,
          value: marketingTotalSales > 0 ? Math.round((val.sales / marketingTotalSales) * 1000) / 10 : 0,
          sales: val.sales,
          count: val.count,
          color: colors[i % colors.length],
        }));

      const normalizeCategory = (value: unknown) => String(value || "").replace(/\s+/g, "").trim();
      const resolveAnalyticsProduct = (productName: string) => {
        const exactMatch = productByName.get(normalizeText(productName));
        if (exactMatch) return exactMatch;
        return productByBaseName.get(getBaseProductKey(productName));
      };
      const isSlotLikeProduct = (productName: string) => {
        const matchedProduct = resolveAnalyticsProduct(productName);
        const normalizedCategory = normalizeCategory(matchedProduct?.category);
        const normalizedName = normalizeCategory(matchedProduct?.name || productName);
        const baseKey = normalizeText(getBaseProductKey(matchedProduct?.name || productName)).toLowerCase();
        const nameKey = normalizeText(normalizedName).toLowerCase();
        return (
          normalizedCategory.includes("슬롯") ||
          normalizedName.includes("슬롯") ||
          SLOT_PRODUCT_ALIAS_KEYS.has(baseKey) ||
          SLOT_PRODUCT_ALIAS_KEYS.has(nameKey)
        );
      };
      const isViralLikeProduct = (productName: string) => {
        const matchedProduct = resolveAnalyticsProduct(productName);
        const normalizedCategory = normalizeCategory(matchedProduct?.category);
        const normalizedName = normalizeCategory(matchedProduct?.name || productName);
        const baseKey = normalizeText(getBaseProductKey(matchedProduct?.name || productName)).toLowerCase();
        const nameKey = normalizeText(normalizedName).toLowerCase();
        return (
          normalizedCategory.includes("바이럴") ||
          VIRAL_PRODUCT_ALIAS_KEYS.has(baseKey) ||
          VIRAL_PRODUCT_ALIAS_KEYS.has(nameKey)
        );
      };

      const excludeRoles = ["대표이사", "총괄이사", "개발자"];
      const excludeDepartments = ["경영진", "개발팀", "연구개발팀", "경영지원실", "경영지원팀"];
      const managerMap: Record<string, { sales: number; refunds: number; count: number; workCost: number; workers: Set<string>; name: string }> = {};
      const ensureManagerSummaryEntry = (managerId: unknown, managerName: unknown) => {
        const normalizedManagerId = normalizeText(managerId);
        const normalizedManagerName = normalizeText(managerName);
        const mgr =
          (normalizedManagerId && usersById.get(normalizedManagerId)) ||
          (normalizedManagerName && usersByName.get(normalizedManagerName)) ||
          users.find((user) => user.id === managerId || user.name === managerName);
        if (mgr && (excludeRoles.includes(mgr.role || "") || excludeDepartments.includes(mgr.department || ""))) return null;
        const managerDisplayName = mgr?.name || normalizeText(managerName) || "미지정";
        const mKey = mgr?.id ? `user:${mgr.id}` : normalizedManagerName ? `name:${normalizedManagerName}` : "name:미지정";
        if (!managerMap[mKey]) managerMap[mKey] = { sales: 0, refunds: 0, count: 0, workCost: 0, workers: new Set(), name: managerDisplayName };
        return managerMap[mKey];
      };
      filtered.forEach((c: any) => {
        const entry = ensureManagerSummaryEntry(c.managerId, c.managerName);
        if (!entry) return;
        entry.sales += getGrossSalesAmount(c);
        entry.count += 1;
        entry.workCost += c.workCost || 0;
        if (c.worker) {
          c.worker.split(",").map((w: string) => w.trim()).filter(Boolean).forEach((w: string) => entry.workers.add(w));
        } else if (c.products) {
          const pNames = c.products.split(",").map((n: string) => n.trim());
          pNames.forEach((pn: string) => {
            const prod = resolveAnalyticsProduct(pn);
            if (prod?.worker) entry.workers.add(prod.worker);
          });
        }
      });
      filteredRefunds.forEach((refund) => {
        const entry = ensureManagerSummaryEntry(null, refund.managerName);
        if (!entry) return;
        entry.refunds += Math.max(Number(refund.amount) || 0, 0);
      });
      const managerData = Object.entries(managerMap)
        .sort(([, a], [, b]) => b.sales - a.sales)
        .map(([, val]) => ({
          manager: val.name,
          매출: val.sales,
          환불: val.refunds,
          건수: val.count,
          작업비: val.workCost,
          작업자: Array.from(val.workers).join(", "),
        }));

      const departmentMap: Record<string, { sales: number; count: number }> = {};
      filtered.forEach(c => {
        const dept = normalizeText(resolveContractDepartment(c)) || "미지정";
        if (!departmentMap[dept]) departmentMap[dept] = { sales: 0, count: 0 };
        departmentMap[dept].sales += getGrossSalesAmount(c);
        departmentMap[dept].count += 1;
      });
      const departmentData = Object.entries(departmentMap)
        .sort(([, a], [, b]) => b.sales - a.sales)
        .map(([department, val]) => ({
          department,
          매출: val.sales,
          건수: val.count,
        }));

      const allDeals = await storage.getDeals();
      let filteredDeals = allDeals;
      if (customerNameValue && customerNameValue !== "all") {
        const matchingCustomerIds = customers
          .filter((customer) => normalizeText(customer.name) === customerNameValue)
          .map((customer) => customer.id);
        filteredDeals = filteredDeals.filter(d => d.customerId && matchingCustomerIds.includes(d.customerId));
      }
      if (managerNameValue && managerNameValue !== "all") {
        const mgrContracts = filtered.filter((contract) => normalizeText(contract.managerName) === managerNameValue);
        const mgrCustomerIds = new Set(mgrContracts.map(c => c.customerId).filter(Boolean));
        filteredDeals = filteredDeals.filter(d => d.customerId && mgrCustomerIds.has(d.customerId));
      }
      if (productFilterValue && productFilterValue !== "all") {
        filteredDeals = filteredDeals.filter((deal) => {
          const product = productById.get(String(deal.productId || ""));
          return normalizeText(product?.name) === productFilterValue;
        });
      }
      if (canApplyDepartmentSplit && departmentFilterValue && departmentFilterValue !== "all") {
        filteredDeals = filteredDeals.filter((deal) => {
          const dealDepartment = resolveDealDepartment(deal);
          if (departmentFilterValue === REGIONAL_DEPARTMENT || departmentFilterValue === MARKETING_DEPARTMENT) {
            return dealDepartment === departmentFilterValue;
          }
          return normalizeText(dealDepartment) === departmentFilterValue;
        });
      }
      if (!isExecutive) {
        const userDept = normalizeText(currentUser.department);
        if (canApplyDepartmentSplit && (userDept === REGIONAL_DEPARTMENT || userDept === MARKETING_DEPARTMENT)) {
          filteredDeals = filteredDeals.filter((deal) => resolveDealDepartment(deal) === userDept);
        } else if (userDept && userDept !== REGIONAL_DEPARTMENT && userDept !== MARKETING_DEPARTMENT) {
          const sameTeamUsers2 = users.filter((user) => normalizeText(user.department) === userDept);
          const sameTeamIds2 = new Set(sameTeamUsers2.map((user) => String(user.id)));
          const sameTeamNames2 = new Set(sameTeamUsers2.map((user) => normalizeText(user.name)).filter(Boolean));
          const teamContracts = contracts.filter((contract) =>
            !isWithdrawnContract(contract) &&
            (
              (contract.managerId && sameTeamIds2.has(String(contract.managerId))) ||
              (normalizeText(contract.managerName) && sameTeamNames2.has(normalizeText(contract.managerName)))
            )
          );
          const teamCustomerIds = new Set(teamContracts.map((contract) => contract.customerId).filter(Boolean));
          filteredDeals = filteredDeals.filter((deal) => deal.customerId && teamCustomerIds.has(deal.customerId));
        }
      }
      const filteredDealsWithoutDate = filteredDeals;
      if (startDateValue || endDateValue) {
        filteredDeals = filteredDeals.filter((d) =>
          (() => {
            const customerId = normalizeText(d.customerId);
            const relatedCustomer = customerId ? customersById.get(customerId) : undefined;
            const relatedContracts = customerId ? contractsByCustomerId.get(customerId) || [] : [];

            const hasContractInRange = relatedContracts.some((contract) =>
              isWithinKoreanDateRange(contract.contractDate, startDateValue || undefined, endDateValue || undefined),
            );
            if (hasContractInRange) return true;

            if (
              relatedCustomer &&
              isWithinKoreanDateRange(relatedCustomer.createdAt, startDateValue || undefined, endDateValue || undefined)
            ) {
              return true;
            }

            // Fallback for deals that are not linked to contract/customer.
            return isWithinKoreanDateRange(d.createdAt, startDateValue || undefined, endDateValue || undefined);
          })(),
        );
      }

      const getAnalyticsDealLines = (deal: typeof filteredDeals[number]) =>
        Math.max(Number(deal.lineCount) || 0, 0);
      const getAnalyticsDealRemainingLines = (deal: typeof filteredDeals[number]) =>
        Math.max((Number(deal.lineCount) || 0) - (Number(deal.cancelledLineCount) || 0), 0);
      const getChurnedAnalyticsDealLines = (deal: typeof filteredDeals[number]) =>
        Math.max(Number(deal.cancelledLineCount) || 0, 0);
      const getCustomerDbAlignedStatus = (deal: typeof filteredDeals[number]) => {
        const normalizedContractStatus = normalizeRegionalDealContractStatus(deal.contractStatus, deal.stage);
        if (normalizedContractStatus === "변경") return "변경";
        if (deal.stage === "churned") return "해지";
        if (deal.stage === "active") return "개통";
        return "인입";
      };

      const isRegionalDepartmentFilter =
        normalizeText(departmentFilterValue) === normalizeText(REGIONAL_DEPARTMENT);
      const dealsSummarySource = isRegionalDepartmentFilter ? filteredDealsWithoutDate : filteredDeals;
      const totalLineCount = dealsSummarySource.reduce((sum, d) => sum + getAnalyticsDealLines(d), 0);
      const inboundDealsForSummary = dealsSummarySource.filter((d) => getCustomerDbAlignedStatus(d) === "인입");
      const openedDealsForSummary = dealsSummarySource.filter((d) => getCustomerDbAlignedStatus(d) === "개통");
      const changedDealsForSummary = dealsSummarySource.filter((d) => getCustomerDbAlignedStatus(d) === "변경");
      const churnedDealsForSummary = dealsSummarySource.filter((d) => getChurnedAnalyticsDealLines(d) > 0);
      const newDeals = inboundDealsForSummary.length;
      const activeDeals = openedDealsForSummary.length;
      const changedDeals = changedDealsForSummary.length;
      const churnedDeals = churnedDealsForSummary.length;
      const newLines = inboundDealsForSummary.reduce((sum, d) => sum + getAnalyticsDealLines(d), 0);
      const activeLines = openedDealsForSummary.reduce((sum, d) => sum + getAnalyticsDealLines(d), 0);
      const changedLines = changedDealsForSummary.reduce((sum, d) => sum + getAnalyticsDealLines(d), 0);
      const churnedLines = dealsSummarySource.reduce((sum, d) => sum + getChurnedAnalyticsDealLines(d), 0);

      const regionalSummarySourceDeals = filteredDealsWithoutDate.filter(
        (deal) => resolveDealDepartment(deal) === REGIONAL_DEPARTMENT,
      );
      const regionalInboundDealsForSummary = regionalSummarySourceDeals.filter(
        (deal) => getCustomerDbAlignedStatus(deal) === "인입",
      );
      const regionalOpenedDealsForSummary = regionalSummarySourceDeals.filter(
        (deal) => getCustomerDbAlignedStatus(deal) === "개통",
      );
      const regionalChangedDealsForSummary = regionalSummarySourceDeals.filter(
        (deal) => getCustomerDbAlignedStatus(deal) === "변경",
      );
      const regionalChurnedDealsForSummary = regionalSummarySourceDeals.filter(
        (deal) => getChurnedAnalyticsDealLines(deal) > 0,
      );
      const regionalSummary = {
        totalLineCount: regionalSummarySourceDeals.reduce((sum, deal) => sum + getAnalyticsDealRemainingLines(deal), 0),
        newDeals: regionalInboundDealsForSummary.length,
        activeDeals: regionalOpenedDealsForSummary.length,
        changedDeals: regionalChangedDealsForSummary.length,
        churnedDeals: regionalChurnedDealsForSummary.length,
        newLines: regionalInboundDealsForSummary.reduce((sum, deal) => sum + getAnalyticsDealLines(deal), 0),
        activeLines: regionalOpenedDealsForSummary.reduce((sum, deal) => sum + getAnalyticsDealLines(deal), 0),
        changedLines: regionalChangedDealsForSummary.reduce((sum, deal) => sum + getAnalyticsDealLines(deal), 0),
        churnedLines: regionalSummarySourceDeals.reduce((sum, deal) => sum + getChurnedAnalyticsDealLines(deal), 0),
      };

      const slotContracts = filtered.filter(c => {
        if (hasSlotContractNumberHint(c)) return true;
        const productNames = getContractAnalyticsProductNames(c);
        return productNames.some((name) => isSlotLikeProduct(name));
      });
      const totalSlotCount = slotContracts.length;

      const viralContracts = filtered.filter(c => {
        if (hasViralContractNumberHint(c)) return true;
        const productNames = getContractAnalyticsProductNames(c);
        return productNames.some((name) => isViralLikeProduct(name));
      });
      const viralContractCount = viralContracts.length;

      const currentMonthKey = getKoreanYearMonthKey(new Date()) || "";
      const currentMonthMetricsMap: Record<string, { sales: number }> = {};
      filteredWithoutDate.forEach((contract) => {
        const key = getKoreanYearMonthKey(contract.contractDate);
        if (!key) return;
        if (!currentMonthMetricsMap[key]) {
          currentMonthMetricsMap[key] = { sales: 0 };
        }
        currentMonthMetricsMap[key].sales += getGrossSalesAmount(contract);
      });
      const currentMonthSales = currentMonthMetricsMap[currentMonthKey]?.sales || 0;
      const settings = await storage.getSystemSettings();
      const targetSetting = settings.find(s => s.settingKey === "monthly_sales_target");
      const monthlyTarget = targetSetting ? parseInt(targetSetting.settingValue) : 50000000;
      const monthlyAchievementRate = monthlyTarget > 0 ? Math.round((currentMonthSales / monthlyTarget) * 1000) / 10 : 0;

      const regionalMonthlySourceDeals =
        departmentFilterValue === REGIONAL_DEPARTMENT
          ? filteredDealsWithoutDate
          : regionalSummarySourceDeals;
      const anchorDate = normalizeToKoreanContractDate(endDateValue || new Date()) ?? new Date();
      const anchorMonthStart = new Date(anchorDate.getFullYear(), anchorDate.getMonth(), 1);
      const recent5MonthKeys: string[] = [];
      for (let offset = 4; offset >= 0; offset -= 1) {
        const monthDate = new Date(anchorMonthStart.getFullYear(), anchorMonthStart.getMonth() - offset, 1);
        recent5MonthKeys.push(`${monthDate.getFullYear()}-${String(monthDate.getMonth() + 1).padStart(2, "0")}`);
      }
      const monthlyNewLineMap: Record<string, number> = {};
      recent5MonthKeys.forEach((key) => {
        monthlyNewLineMap[key] = 0;
      });
      regionalMonthlySourceDeals.forEach((deal) => {
        const openDate = getRegionalDealOpenAnalyticsDate(deal);
        const openDateKey = openDate ? getKoreanDateKey(openDate) : null;
        if (!openDateKey) return;
        const yearMonthKey = openDateKey.slice(0, 7);
        if (!(yearMonthKey in monthlyNewLineMap)) return;
        monthlyNewLineMap[yearMonthKey] += Math.max(0, toAmount(deal.lineCount));
      });
      const monthlyNewDealsData = recent5MonthKeys.map((key) => ({
        month: `${parseInt(key.split("-")[1], 10)}월`,
        yearMonth: key,
        lineCount: monthlyNewLineMap[key] || 0,
      }));

      const regionalMonthlyStatusData = await (async () => {
        const monthKeysInRange = buildRegionalMonthlyYearMonthRange(startDateValue || undefined, endDateValue || undefined);
        if (monthKeysInRange.length === 0) return [];

        const openLinesMap = new Map<string, number>(monthKeysInRange.map((key) => [key, 0]));
        const churnLinesMap = new Map<string, number>(monthKeysInRange.map((key) => [key, 0]));
        const managementCostMap = new Map<string, number>(monthKeysInRange.map((key) => [key, 0]));
        const currentTotalLineCount = regionalMonthlySourceDeals.reduce(
          (sum, deal) => sum + Math.max(Number(deal.lineCount) || 0, 0),
          0,
        );
        const monthMetaMap = new Map(
          monthKeysInRange.map((yearMonth) => {
            const monthStart = new Date(`${yearMonth}-01T12:00:00+09:00`);
            const daysInMonth = Number.isNaN(monthStart.getTime())
              ? 30
              : new Date(monthStart.getFullYear(), monthStart.getMonth() + 1, 0).getDate();
            return [
              yearMonth,
              {
                monthStartKey: `${yearMonth}-01`,
                daysInMonth,
                dayPrice: 500 / daysInMonth,
              },
            ] as const;
          }),
        );

        const regionalManagementFeeRows = await db
          .select({
            feeDate: regionalManagementFees.feeDate,
            amount: regionalManagementFees.amount,
          })
          .from(regionalManagementFees);

        regionalManagementFeeRows.forEach((row) => {
          const yearMonth = getKoreanDateKey(row.feeDate)?.slice(0, 7);
          if (!yearMonth || !managementCostMap.has(yearMonth)) return;
          managementCostMap.set(yearMonth, (managementCostMap.get(yearMonth) || 0) + Math.max(Number(row.amount) || 0, 0));
        });

        const regionalDealIds = regionalMonthlySourceDeals.map((deal) => deal.id).filter(Boolean);
        const timelineRows =
          regionalDealIds.length > 0
            ? await db
                .select({
                  dealId: dealTimelines.dealId,
                  content: dealTimelines.content,
                })
                .from(dealTimelines)
                .where(inArray(dealTimelines.dealId, regionalDealIds))
            : [];
        const timelineContentByDealId = new Map<string, string[]>();
        timelineRows.forEach((timeline) => {
          const dealId = normalizeText(timeline.dealId);
          if (!dealId) return;
          const existing = timelineContentByDealId.get(dealId) || [];
          existing.push(String(timeline.content || ""));
          timelineContentByDealId.set(dealId, existing);
        });

        const regionalChurnChildrenByParentId = new Map<
          string,
          Array<{
            count: number;
            churnDateKey: string | null;
          }>
        >();
        regionalMonthlySourceDeals.forEach((deal) => {
          const parentDealId = normalizeText(deal.parentDealId);
          if (!parentDealId || deal.stage !== "churned") return;
          const churnCount = Math.max(Math.max(Number(deal.cancelledLineCount) || 0, Number(deal.lineCount) || 0), 0);
          if (churnCount <= 0) return;
          const existing = regionalChurnChildrenByParentId.get(parentDealId) || [];
          existing.push({
            count: churnCount,
            churnDateKey: deal.churnDate ? getKoreanDateKey(deal.churnDate) : null,
          });
          regionalChurnChildrenByParentId.set(parentDealId, existing);
        });

        const getRegionalMonthlyChurnCount = (
          deal: Pick<Deal, "id" | "parentDealId" | "lineCount" | "cancelledLineCount" | "stage" | "churnDate">,
        ) => {
          if (deal.stage !== "churned") return 0;

          const baseCount = Math.max(Math.max(Number(deal.cancelledLineCount) || 0, Number(deal.lineCount) || 0), 0);
          if (baseCount <= 0) return 0;

          if (normalizeText(deal.parentDealId)) {
            return baseCount;
          }

          const dealId = normalizeText(deal.id);
          if (!dealId) return baseCount;

          const childRows = regionalChurnChildrenByParentId.get(dealId) || [];
          if (childRows.length === 0) return baseCount;

          const churnDateKey = deal.churnDate ? getKoreanDateKey(deal.churnDate) : null;
          const childCancelledCount = childRows.reduce((sum, child) => {
            if (!churnDateKey || !child.churnDateKey) {
              return sum + child.count;
            }
            return child.churnDateKey <= churnDateKey ? sum + child.count : sum;
          }, 0);

          return Math.max(baseCount - childCancelledCount, 0);
        };

        const applyOpenLines = (yearMonth: string | null, count: number) => {
          if (!yearMonth || count <= 0) return;
          if (openLinesMap.has(yearMonth)) {
            openLinesMap.set(yearMonth, (openLinesMap.get(yearMonth) || 0) + count);
          }
        };

        const applyChurnLines = (yearMonth: string | null, count: number) => {
          if (!yearMonth || count <= 0) return;
          if (churnLinesMap.has(yearMonth)) {
            churnLinesMap.set(yearMonth, (churnLinesMap.get(yearMonth) || 0) + count);
          }
        };

        regionalMonthlySourceDeals.forEach((deal) => {
          const lineCount = Math.max(Number(deal.lineCount) || 0, 0);
          const timelineContents = timelineContentByDealId.get(deal.id) || [];

          const addedEvents = timelineContents
            .map((content) => parseRegionalTimelineAddEventDetail(content))
            .filter((event): event is RegionalTimelineLineEvent => !!event);

          const addedLineCount = addedEvents.reduce((sum, event) => sum + event.count, 0);
          const baseOpenLines = Math.max(lineCount - addedLineCount, 0);
          const openDate = getRegionalDealOpenAnalyticsDate(deal);
          const openMonthKey = openDate ? getKoreanYearMonthKey(openDate) : null;
          const openDateKey = openDate ? getKoreanDateKey(openDate) : null;

          applyOpenLines(openMonthKey, baseOpenLines);
          addedEvents.forEach((event) => applyOpenLines(event.yearMonth, event.count));

          const openRevenueEvents: RegionalTimelineLineEvent[] = [];
          if (openDateKey && baseOpenLines > 0) {
            openRevenueEvents.push({
              dateKey: openDateKey,
              yearMonth: openDateKey.slice(0, 7),
              count: baseOpenLines,
            });
          }
          openRevenueEvents.push(...addedEvents);

          const churnRevenueEvents: RegionalTimelineLineEvent[] = [];

          if (deal.stage === "churned") {
            const fullChurnLines = getRegionalMonthlyChurnCount(deal);
            const churnDateKey = deal.churnDate ? getKoreanDateKey(deal.churnDate) : null;
            const churnMonthKey = deal.churnDate ? getKoreanYearMonthKey(deal.churnDate) : null;
            applyChurnLines(churnMonthKey, fullChurnLines);

            if (churnDateKey && fullChurnLines > 0) {
              churnRevenueEvents.push({
                dateKey: churnDateKey,
                yearMonth: churnDateKey.slice(0, 7),
                count: fullChurnLines,
              });
            }
          }

        });

        const totalLinesByMonth = new Map<string, number>();
        if (monthKeysInRange.length > 0) {
          const latestMonthKey = monthKeysInRange[monthKeysInRange.length - 1];
          totalLinesByMonth.set(latestMonthKey, Math.max(currentTotalLineCount, 0));
          for (let index = monthKeysInRange.length - 2; index >= 0; index -= 1) {
            const nextMonthKey = monthKeysInRange[index + 1];
            const nextMonthTotal = totalLinesByMonth.get(nextMonthKey) || 0;
            const previousMonthTotal = Math.max(
              nextMonthTotal - (openLinesMap.get(nextMonthKey) || 0) + (churnLinesMap.get(nextMonthKey) || 0),
              0,
            );
            totalLinesByMonth.set(monthKeysInRange[index], previousMonthTotal);
          }
        }

        const previousMonthTotalLinesByMonth = new Map<string, number>();
        monthKeysInRange.forEach((yearMonth, index) => {
          if (index === 0) {
            const currentMonthTotal = totalLinesByMonth.get(yearMonth) || 0;
            const previousMonthTotal = Math.max(
              currentMonthTotal - (openLinesMap.get(yearMonth) || 0) + (churnLinesMap.get(yearMonth) || 0),
              0,
            );
            previousMonthTotalLinesByMonth.set(yearMonth, previousMonthTotal);
            return;
          }
          previousMonthTotalLinesByMonth.set(yearMonth, totalLinesByMonth.get(monthKeysInRange[index - 1]) || 0);
        });

        return monthKeysInRange.map((yearMonth) => {
          const openLines = openLinesMap.get(yearMonth) || 0;
          const churnLines = churnLinesMap.get(yearMonth) || 0;
          const totalMovement = openLines + churnLines;
          const totalLines = totalLinesByMonth.get(yearMonth) || 0;
          const previousMonthTotalLines = previousMonthTotalLinesByMonth.get(yearMonth) || 0;
          const monthMeta = monthMetaMap.get(yearMonth);

          let openedRevenue = 0;
          let churnDeduction = 0;
          if (monthMeta) {
            regionalMonthlySourceDeals.forEach((deal) => {
              const lineCount = Math.max(Number(deal.lineCount) || 0, 0);
              const timelineContents = timelineContentByDealId.get(deal.id) || [];

              const addedEvents = timelineContents
                .map((content) => parseRegionalTimelineAddEventDetail(content))
                .filter((event): event is RegionalTimelineLineEvent => !!event);

              const addedLineCount = addedEvents.reduce((sum, event) => sum + event.count, 0);
              const baseOpenLines = Math.max(lineCount - addedLineCount, 0);
              const openDate = getRegionalDealOpenAnalyticsDate(deal);
              const openDateKey = openDate ? getKoreanDateKey(openDate) : null;

              const openRevenueEvents: RegionalTimelineLineEvent[] = [];
              if (openDateKey && baseOpenLines > 0) {
                openRevenueEvents.push({
                  dateKey: openDateKey,
                  yearMonth: openDateKey.slice(0, 7),
                  count: baseOpenLines,
                });
              }
              openRevenueEvents.push(...addedEvents);

              const churnRevenueEvents: RegionalTimelineLineEvent[] = [];
              if (deal.stage === "churned") {
                const fullChurnLines = getRegionalMonthlyChurnCount(deal);
                const churnDateKey = deal.churnDate ? getKoreanDateKey(deal.churnDate) : null;
                if (churnDateKey && fullChurnLines > 0) {
                  churnRevenueEvents.push({
                    dateKey: churnDateKey,
                    yearMonth: churnDateKey.slice(0, 7),
                    count: fullChurnLines,
                  });
                }
              }

              openedRevenue += openRevenueEvents
                .filter((event) => event.yearMonth === yearMonth)
                .reduce((sum, event) => {
                  const openDay = Number.parseInt(event.dateKey.slice(8, 10), 10) || 0;
                  return sum + event.count * monthMeta.dayPrice * Math.max(monthMeta.daysInMonth - openDay + 1, 0);
                }, 0);

              churnDeduction += churnRevenueEvents
                .filter((event) => event.yearMonth === yearMonth)
                .reduce((sum, event) => {
                  const churnDay = Number.parseInt(event.dateKey.slice(8, 10), 10) || 0;
                  return sum + event.count * monthMeta.dayPrice * Math.max(monthMeta.daysInMonth - churnDay, 0);
                }, 0);
            });
          }

          const operatingSales = Math.max(previousMonthTotalLines * 500 + openedRevenue - churnDeduction, 0);

          return {
            yearMonth,
            monthLabel: `${parseInt(yearMonth.split("-")[1] || "0", 10)}월`,
            openLines,
            churnLines,
            openRate: totalMovement > 0 ? (openLines / totalMovement) * 100 : 0,
            churnRate: totalMovement > 0 ? (churnLines / totalMovement) * 100 : 0,
            openTarget: REGIONAL_MONTHLY_OPEN_TARGET,
            churnDefenseTarget: REGIONAL_MONTHLY_CHURN_DEFENSE_TARGET,
            openAchievementRate:
              REGIONAL_MONTHLY_OPEN_TARGET > 0 ? (openLines / REGIONAL_MONTHLY_OPEN_TARGET) * 100 : 0,
            churnDefenseAchievementRate:
              REGIONAL_MONTHLY_CHURN_DEFENSE_TARGET > 0
                ? (churnLines / REGIONAL_MONTHLY_CHURN_DEFENSE_TARGET) * 100
                : 0,
            totalLines,
            sales: Math.max(Math.round(operatingSales), 0),
            managementCost: managementCostMap.get(yearMonth) || 0,
            monthlyLines: totalLines,
            churnLineRate: totalMovement > 0 ? (churnLines / totalMovement) * 100 : 0,
          };
        });
      })();

      const productLineMap: Record<string, number> = {};
      filteredDeals.forEach(d => {
        const product = products.find(p => p.id === d.productId);
        const pName = product?.name || "기타";
        productLineMap[pName] = (productLineMap[pName] || 0) + getAnalyticsDealLines(d);
      });
      const totalLines = Object.values(productLineMap).reduce((s, v) => s + v, 0);
      const productLineData = Object.entries(productLineMap)
        .sort(([, a], [, b]) => b - a)
        .map(([name, lines], i) => ({
          name,
          value: totalLines > 0 ? Math.round((lines / totalLines) * 1000) / 10 : 0,
          lines,
          color: colors[i % colors.length],
        }));

      const managerLineMap: Record<string, { lines: number; newCount: number; activeCount: number; churnedCount: number }> = {};
      for (const d of filteredDeals) {
        let mgrName = "미지정";
        if (d.customerId) {
          const contract = filtered.find((c: any) => c.customerId === d.customerId);
          if (contract) mgrName = contract.managerName;
        }
        if (!managerLineMap[mgrName]) managerLineMap[mgrName] = { lines: 0, newCount: 0, activeCount: 0, churnedCount: 0 };
        managerLineMap[mgrName].lines += getAnalyticsDealLines(d);
        if (d.stage === "new") managerLineMap[mgrName].newCount += 1;
        else if (d.stage === "active") managerLineMap[mgrName].activeCount += 1;
        if (getChurnedAnalyticsDealLines(d) > 0) managerLineMap[mgrName].churnedCount += 1;
      }
      const managerLineData = Object.entries(managerLineMap)
        .sort(([, a], [, b]) => b.lines - a.lines)
        .map(([manager, val]) => ({
          manager,
          회선수: val.lines,
          인입: val.newCount,
          개통: val.activeCount,
          해지: val.churnedCount,
        }));

      const productTimelineMap: Record<string, { dealId: string; productName: string; content: string; authorName: string; createdAt: string }> = {};
      for (const d of filteredDeals) {
        const product = products.find(p => p.id === d.productId);
        const pName = product?.name || "기타";
        const timelines = await storage.getDealTimelines(d.id);
        if (timelines.length > 0) {
          const latest = timelines.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
          if (!productTimelineMap[pName] || new Date(latest.createdAt) > new Date(productTimelineMap[pName].createdAt)) {
            productTimelineMap[pName] = {
              dealId: d.id,
              productName: pName,
              content: latest.content,
              authorName: latest.authorName || "",
              createdAt: latest.createdAt.toISOString ? latest.createdAt.toISOString() : String(latest.createdAt),
            };
          }
        }
      }
      const productTimelineData = Object.values(productTimelineMap).sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());

      res.json({
        isExecutive: !!isExecutive,
        userName: currentUser?.name || "",
        summary: { totalSales, totalRefunds, netSales, contractCount, avgDealAmount, confirmedCount, confirmRate },
        monthlyData,
        productData,
        marketingProductData,
        managerData,
        departmentData,
        dealsSummary: {
          totalLineCount,
          newDeals,
          activeDeals,
          changedDeals,
          churnedDeals,
          newLines,
          activeLines,
          changedLines,
          churnedLines,
          totalSlotCount,
          viralContractCount,
          monthlyAchievementRate,
          currentMonthSales,
        },
        regionalData: {
          summary: regionalSummary,
          monthlyNewDealsData,
          monthlyStatusData: regionalMonthlyStatusData,
          productLineData,
          managerLineData,
          productTimelineData,
        },
      });
    } catch (error) {
      console.error("Error fetching sales analytics:", error);
      res.status(500).json({ error: "Failed to fetch sales analytics" });
    }
  });

  app.get("/api/system-settings", async (_req, res) => {
    try {
      const settings = await storage.getSystemSettings();
      const settingsMap: Record<string, string> = {};
      settings.forEach(s => { settingsMap[s.settingKey] = s.settingValue; });
      res.json(settingsMap);
    } catch (error) {
      console.error("Error fetching system settings:", error);
      res.status(500).json({ error: "Failed to fetch system settings" });
    }
  });

  // ===== 공지사항 API =====
  app.get("/api/notices", requireAuth, async (req, res) => {
    try {
      const noticeList = await storage.getNotices();
      res.json(noticeList);
    } catch (error) {
      console.error("Error fetching notices:", error);
      res.status(500).json({ error: "Failed to fetch notices" });
    }
  });

  app.get("/api/notices/:id", requireAuth, async (req, res) => {
    try {
      const noticeId = toSingleString(req.params.id);
      const notice = await storage.getNotice(noticeId);
      if (!notice) {
        return res.status(404).json({ error: "Notice not found" });
      }
      await storage.incrementNoticeViewCount(noticeId);
      res.json({ ...notice, viewCount: (notice.viewCount || 0) + 1 });
    } catch (error) {
      console.error("Error fetching notice:", error);
      res.status(500).json({ error: "Failed to fetch notice" });
    }
  });

  app.post("/api/notices", requireAdmin, async (req, res) => {
    try {
      const parsed = insertNoticeSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid notice data", details: parsed.error });
      }
      const notice = await storage.createNotice(parsed.data);
      res.status(201).json(notice);
    } catch (error) {
      console.error("Error creating notice:", error);
      res.status(500).json({ error: "Failed to create notice" });
    }
  });

  app.put("/api/notices/:id", requireAdmin, async (req, res) => {
    try {
      const noticeId = toSingleString(req.params.id);
      const parsed = insertNoticeSchema.partial().safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid notice data", details: parsed.error });
      }
      const notice = await storage.updateNotice(noticeId, parsed.data);
      if (!notice) {
        return res.status(404).json({ error: "Notice not found" });
      }
      res.json(notice);
    } catch (error) {
      console.error("Error updating notice:", error);
      res.status(500).json({ error: "Failed to update notice" });
    }
  });

  app.delete("/api/notices/:id", requireAdmin, async (req, res) => {
    try {
      const noticeId = toSingleString(req.params.id);
      await storage.deleteNotice(noticeId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting notice:", error);
      res.status(500).json({ error: "Failed to delete notice" });
    }
  });

  app.put("/api/system-settings", requireDeveloper, async (req, res) => {
    try {
      const settingsSchema = z.record(z.string(), z.string());
      const parsed = settingsSchema.safeParse(req.body);
      if (!parsed.success) {
        return res.status(400).json({ error: "Invalid settings data", details: parsed.error });
      }
      await storage.setSystemSettingsBulk(parsed.data);
      await writeSystemLog(req, {
        actionType: "settings_change",
        action: "시스템 설정 변경",
        details: `keys=${Object.keys(parsed.data).join(",")}`,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error saving system settings:", error);
      res.status(500).json({ error: "Failed to save system settings" });
    }
  });

  async function requireDeveloper(req: Request, res: Response, next: NextFunction) {
    if (!req.session.userId) {
      return res.status(401).json({ error: "로그인이 필요합니다." });
    }
    const currentUser = await storage.getUser(req.session.userId);
    if (!currentUser || currentUser.role !== "개발자") {
      return res.status(403).json({ error: "개발자 권한이 필요합니다." });
    }
    next();
  }

  async function collectBackupTables() {
    return {
      users: await db.select().from(users),
      customers: await db.select().from(customers),
      contacts: await db.select().from(contacts),
      deals: await db.select().from(deals),
      dealTimelines: await db.select().from(dealTimelines),
      regionalCustomerLists: await db.select().from(regionalCustomerLists),
      activities: await db.select().from(activities),
      payments: await db.select().from(payments),
      products: await db.select().from(products),
      contracts: await db.select().from(contracts),
      refunds: await db.select().from(refunds),
      keeps: await db.select().from(keeps),
      regionalManagementFees: await db.select().from(regionalManagementFees),
      deposits: await db.select().from(deposits),
      notices: await db.select().from(notices),
      pagePermissions: await db.select().from(pagePermissions),
      systemSettings: await db.select().from(systemSettings),
      systemLogs: await db.select().from(systemLogs),
    };
  }

  app.use("/api/backups", requireAuth);

  app.get("/api/backups", requireDeveloper, async (_req, res) => {
    try {
      const backupList = await storage.getBackups();
      res.json(backupList);
    } catch (error) {
      console.error("Error fetching backups:", error);
      res.status(500).json({ error: "백업 목록 조회에 실패했습니다." });
    }
  });

  app.get("/api/backups/status", requireDeveloper, async (_req, res) => {
    try {
      const backups = await storage.getBackups();
      const retentionCount = await getBackupRetentionCount();
      const totalSizeBytes = backups.reduce((sum, item) => sum + (item.sizeBytes || 0), 0);
      const latest = backups[0] || null;
      res.json({
        count: backups.length,
        retentionCount,
        totalSizeBytes,
        latestBackup: latest
          ? {
              id: latest.id,
              label: latest.label,
              createdAt: latest.createdAt,
              sizeBytes: latest.sizeBytes,
              createdByName: latest.createdByName,
            }
          : null,
      });
    } catch (error) {
      console.error("Error fetching backup status:", error);
      res.status(500).json({ error: "백업 상태 조회에 실패했습니다." });
    }
  });

  app.post("/api/backups", requireDeveloper, async (req, res) => {
    const releaseLock = await tryAcquireBackupOperationLock();
    if (!releaseLock) {
      return res.status(409).json({ error: "다른 백업/복원 작업이 진행 중입니다. 잠시 후 다시 시도해주세요." });
    }
    try {
      assertBackupEncryptionReadyForProduction();
      const userId = req.session.userId;
      const currentUser = userId ? await storage.getUser(userId) : null;

      const backupTables = await collectBackupTables();

      const tableCounts: Record<string, number> = {};
      for (const [key, rows] of Object.entries(backupTables)) {
        tableCounts[key] = (rows as any[]).length;
      }

      const backupPayload = buildBackupPayload(backupTables as Record<string, unknown>);
      const serializedBackup = serializeBackupData(JSON.stringify(backupPayload));
      const backupData = serializedBackup.stored;

      const sizeBytes = Buffer.byteLength(backupData, "utf-8");
      if (sizeBytes > BACKUP_MAX_BYTES) {
        return res.status(413).json({
          error: `백업 데이터 용량이 너무 큽니다. (${Math.round(sizeBytes / (1024 * 1024))}MB)`,
        });
      }

      const rawLabel = toSingleString(req.body?.label).trim();
      const label = rawLabel || `백업 ${new Date().toLocaleString("ko-KR", { timeZone: cachedTimezone })}`;

      const backup = await storage.createBackup({
        label,
        createdByName: currentUser?.name || "Unknown",
        createdByUserId: userId || null,
        tableCounts: JSON.stringify(tableCounts),
        sizeBytes,
        data: backupData,
      });

      await writeSystemLog(req, {
        actionType: "data_backup",
        action: `데이터 백업 생성: ${label}`,
        details: `tables=${Object.keys(tableCounts).length}, sizeKB=${(sizeBytes / 1024).toFixed(1)}, encrypted=${serializedBackup.encrypted}, sha256=${backupPayload.integrity.contentHash.slice(0, 16)}`,
      });

      const retentionCount = await getBackupRetentionCount();
      const prunedCount = await pruneOldBackups(retentionCount);
      if (prunedCount > 0) {
        await writeSystemLog(req, {
          actionType: "data_backup",
          action: `백업 보존 정책 정리 실행 (보존 ${retentionCount}개)`,
          details: `deletedBackups=${prunedCount}`,
        });
      }

      const { data: _, ...backupMeta } = backup;
      res.json(backupMeta);
    } catch (error) {
      console.error("Error creating backup:", error);
      res.status(500).json({ error: "백업 생성에 실패했습니다." });
    } finally {
      await releaseLock();
    }
  });

  app.get("/api/backups/:id/download", requireDeveloper, async (req, res) => {
    try {
      const backupId = toSingleString(req.params.id);
      const backup = await storage.getBackup(backupId);
      if (!backup) {
        return res.status(404).json({ error: "백업을 찾을 수 없습니다." });
      }
      let integrityHash = "";
      try {
        const parsedPayload = JSON.parse(deserializeBackupData(backup.data).plaintext);
        const integrity = verifyBackupPayloadIntegrity(parsedPayload);
        integrityHash = integrity.hash;
      } catch {
        integrityHash = "";
      }
      await writeSystemLog(req, {
        actionType: "data_backup",
        action: `데이터 백업 다운로드: ${backup.label || backup.id}`,
        details: `backupId=${backup.id}`,
      });
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Content-Disposition", `attachment; filename="crm-backup-${backup.id}.json"`);
      if (integrityHash) {
        res.setHeader("X-Backup-Sha256", integrityHash);
      }
      res.send(deserializeBackupData(backup.data).plaintext);
    } catch (error) {
      console.error("Error downloading backup:", error);
      res.status(500).json({ error: "백업 다운로드에 실패했습니다." });
    }
  });

  app.delete("/api/backups/:id", requireDeveloper, async (req, res) => {
    const releaseLock = await tryAcquireBackupOperationLock();
    if (!releaseLock) {
      return res.status(409).json({ error: "백업/복원 작업 중에는 삭제할 수 없습니다." });
    }
    try {
      const backupId = toSingleString(req.params.id);
      const backup = await storage.getBackup(backupId);
      await storage.deleteBackup(backupId);
      await writeSystemLog(req, {
        actionType: "data_backup",
        action: `데이터 백업 삭제: ${backup?.label || backupId}`,
        details: `backupId=${backupId}`,
      });
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting backup:", error);
      res.status(500).json({ error: "백업 삭제에 실패했습니다." });
    } finally {
      await releaseLock();
    }
  });

  app.post("/api/backups/:id/restore", requireDeveloper, async (req, res) => {
    const releaseLock = await tryAcquireBackupOperationLock();
    if (!releaseLock) {
      return res.status(409).json({ error: "다른 백업/복원 작업이 진행 중입니다. 잠시 후 다시 시도해주세요." });
    }
    try {
      if (!req.body.confirm) {
        return res.status(400).json({ error: "복원 확인이 필요합니다." });
      }

      const backupId = toSingleString(req.params.id);
      const backup = await storage.getBackup(backupId);
      if (!backup) {
        return res.status(404).json({ error: "백업을 찾을 수 없습니다." });
      }

      const backupData = JSON.parse(deserializeBackupData(backup.data).plaintext);
      const integrity = verifyBackupPayloadIntegrity(backupData);
      if (!integrity.isValid) {
        return res.status(400).json({ error: `백업 무결성 검증 실패(${integrity.reason})` });
      }
      const tables = backupData.tables;
      const tableValidation = validateBackupTablesShape(tables);
      if (!tableValidation.isValid) {
        return res.status(400).json({
          error: "백업 데이터 구조가 올바르지 않습니다.",
          details: {
            missingTables: tableValidation.missing,
            invalidTables: tableValidation.invalid,
          },
        });
      }

      const userId = req.session.userId;
      const currentUser = userId ? await storage.getUser(userId) : null;

      // 복원 전에 현재 상태를 자동 스냅샷으로 남겨 롤백 가능성을 확보한다.
      assertBackupEncryptionReadyForProduction();
      const preRestoreTables = await collectBackupTables();
      const preRestorePayload = buildBackupPayload(preRestoreTables as Record<string, unknown>);
      const serializedPreRestore = serializeBackupData(JSON.stringify(preRestorePayload));
      const preRestoreData = serializedPreRestore.stored;
      const preRestoreSizeBytes = Buffer.byteLength(preRestoreData, "utf-8");
      if (preRestoreSizeBytes > BACKUP_MAX_BYTES) {
        return res.status(413).json({
          error: `복원 전 자동 백업 용량이 제한을 초과했습니다. (${Math.round(preRestoreSizeBytes / (1024 * 1024))}MB)`,
        });
      }
      const preRestoreTableCounts: Record<string, number> = {};
      for (const [key, rows] of Object.entries(preRestoreTables)) {
        preRestoreTableCounts[key] = (rows as any[]).length;
      }
      const preRestoreLabel = "AUTO_PRE_RESTORE_" + new Date().toLocaleString("ko-KR", { timeZone: cachedTimezone });
      await storage.createBackup({
        label: preRestoreLabel,
        createdByName: currentUser?.name || "system",
        createdByUserId: userId || null,
        tableCounts: JSON.stringify(preRestoreTableCounts),
        sizeBytes: preRestoreSizeBytes,
        data: preRestoreData,
      });

      await db.transaction(async (tx) => {
        await tx.delete(dealTimelines);
        await tx.delete(regionalCustomerLists);
        await tx.delete(activities);
        await tx.delete(refunds);
        await tx.delete(keeps);
        await tx.delete(regionalManagementFees);
        await tx.delete(deposits);
        await tx.delete(payments);
        await tx.delete(contracts);
        await tx.delete(contacts);
        await tx.delete(deals);
        await tx.delete(customers);
        await tx.delete(products);
        await tx.delete(notices);
        await tx.delete(pagePermissions);
        await tx.delete(systemSettings);
        await tx.delete(systemLogs);
        await tx.delete(users);

        if (tables.users?.length) await tx.insert(users).values(tables.users);
        if (tables.customers?.length) await tx.insert(customers).values(tables.customers);
        if (tables.contacts?.length) await tx.insert(contacts).values(tables.contacts);
        if (tables.products?.length) await tx.insert(products).values(tables.products);
        if (tables.deals?.length) await tx.insert(deals).values(tables.deals);
        if (tables.dealTimelines?.length) await tx.insert(dealTimelines).values(tables.dealTimelines);
        if (tables.regionalCustomerLists?.length) await tx.insert(regionalCustomerLists).values(tables.regionalCustomerLists);
        if (tables.activities?.length) await tx.insert(activities).values(tables.activities);
        if (tables.contracts?.length) await tx.insert(contracts).values(tables.contracts);
        if (tables.refunds?.length) await tx.insert(refunds).values(tables.refunds);
        if (tables.keeps?.length) await tx.insert(keeps).values(tables.keeps);
        if (tables.regionalManagementFees?.length) await tx.insert(regionalManagementFees).values(tables.regionalManagementFees);
        if (tables.payments?.length) await tx.insert(payments).values(tables.payments);
        if (tables.deposits?.length) await tx.insert(deposits).values(tables.deposits);
        if (tables.notices?.length) await tx.insert(notices).values(tables.notices);
        if (tables.pagePermissions?.length) await tx.insert(pagePermissions).values(tables.pagePermissions);
        if (tables.systemSettings?.length) await tx.insert(systemSettings).values(tables.systemSettings);
        if (tables.systemLogs?.length) await tx.insert(systemLogs).values(tables.systemLogs);
      });

      await writeSystemLog(req, {
        actionType: "data_backup",
        action: `데이터 백업 복원: ${backup.label || backup.id}`,
        details: `backupId=${backup.id}, integrity=${integrity.reason}, encryptedSnapshot=${serializedPreRestore.encrypted}, sha256=${integrity.hash.slice(0, 16)}`,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error restoring backup:", error);
      res.status(500).json({ error: "백업 복원에 실패했습니다." });
    } finally {
      await releaseLock();
    }
  });

  const ADMIN_TABLE_WHITELIST = [
    "users", "customers", "contacts", "deals", "deal_timelines",
    "regional_customer_lists", "activities", "payments", "system_logs", "products", "contracts",
    "refunds", "keeps", "deposits", "notices", "page_permissions",
    "system_settings", "database_backups"
  ];

  app.get("/api/admin/schema", requireDeveloper, async (_req, res) => {
    try {
      const result = await pool.query(`
        SELECT 
          t.table_name,
          c.column_name,
          c.data_type,
          c.character_maximum_length,
          c.is_nullable,
          c.column_default,
          CASE WHEN pk.column_name IS NOT NULL THEN true ELSE false END as is_primary_key,
          CASE WHEN fk.column_name IS NOT NULL THEN true ELSE false END as is_foreign_key,
          fk.foreign_table_name,
          fk.foreign_column_name
        FROM information_schema.tables t
        JOIN information_schema.columns c ON t.table_name = c.table_name AND t.table_schema = c.table_schema
        LEFT JOIN (
          SELECT ku.table_name, ku.column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_schema = 'public'
        ) pk ON pk.table_name = c.table_name AND pk.column_name = c.column_name
        LEFT JOIN (
          SELECT 
            ku.table_name, ku.column_name,
            ccu.table_name as foreign_table_name,
            ccu.column_name as foreign_column_name
          FROM information_schema.table_constraints tc
          JOIN information_schema.key_column_usage ku ON tc.constraint_name = ku.constraint_name
          JOIN information_schema.constraint_column_usage ccu ON tc.constraint_name = ccu.constraint_name
          WHERE tc.constraint_type = 'FOREIGN KEY' AND tc.table_schema = 'public'
        ) fk ON fk.table_name = c.table_name AND fk.column_name = c.column_name
        WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        ORDER BY t.table_name, c.ordinal_position
      `);
      
      const tables: Record<string, any> = {};
      for (const row of result.rows) {
        if (!tables[row.table_name]) {
          tables[row.table_name] = { name: row.table_name, columns: [] };
        }
        tables[row.table_name].columns.push({
          name: row.column_name,
          type: row.data_type,
          maxLength: row.character_maximum_length,
          nullable: row.is_nullable === "YES",
          defaultValue: row.column_default,
          isPrimaryKey: row.is_primary_key,
          isForeignKey: row.is_foreign_key,
          foreignTable: row.foreign_table_name,
          foreignColumn: row.foreign_column_name,
        });
      }

      const countResult = await pool.query(`
        SELECT schemaname, relname as table_name, n_live_tup as row_count
        FROM pg_stat_user_tables WHERE schemaname = 'public'
      `);
      for (const row of countResult.rows) {
        if (tables[row.table_name]) {
          tables[row.table_name].rowCount = parseInt(row.row_count) || 0;
        }
      }

      res.json(Object.values(tables));
    } catch (error) {
      console.error("Error fetching schema:", error);
      res.status(500).json({ error: "스키마 조회에 실패했습니다." });
    }
  });

  app.get("/api/admin/tables/:table/rows", requireDeveloper, async (req, res) => {
    try {
      const table = toSingleString(req.params.table);
      if (!ADMIN_TABLE_WHITELIST.includes(table)) {
        return res.status(400).json({ error: "허용되지 않는 테이블입니다." });
      }
      const limit = Math.min(parseInt(req.query.limit as string) || 50, 200);
      const offset = parseInt(req.query.offset as string) || 0;
      const orderBy = (req.query.orderBy as string) || "id";
      const orderDir = (req.query.orderDir as string) === "asc" ? "ASC" : "DESC";
      const search = req.query.search as string;

      const colCheck = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const validColumns = colCheck.rows.map((r: any) => r.column_name);
      const safeOrderBy = validColumns.includes(orderBy) ? orderBy : validColumns[0] || "id";

      let whereClause = "";
      const params: any[] = [limit, offset];
      const encryptedColumns = new Set(getRawTablePiiColumns(table));

      if (search && search.trim()) {
        const textCols = validColumns.filter((col: string) => !encryptedColumns.has(col)).slice(0, 5);
        if (textCols.length > 0) {
          const conditions = textCols.map((col: string, i: number) => `CAST("${col}" AS TEXT) ILIKE $${i + 3}`);
          whereClause = `WHERE ${conditions.join(" OR ")}`;
          for (let i = 0; i < textCols.length; i++) {
            params.push(`%${search.trim()}%`);
          }
        }
      }

      const countResult = await pool.query(
        `SELECT COUNT(*) as total FROM "${table}" ${whereClause}`,
        whereClause ? params.slice(2) : []
      );
      const total = parseInt(countResult.rows[0].total);

      const dataResult = await pool.query(
        `SELECT * FROM "${table}" ${whereClause} ORDER BY "${safeOrderBy}" ${orderDir} LIMIT $1 OFFSET $2`,
        params
      );

      const sensitiveColumns = ["password"];
      const rows = dataResult.rows.map((row: any) => {
        const cleaned = decryptRawTableRow(table, row);
        for (const col of sensitiveColumns) {
          if (cleaned[col]) cleaned[col] = "********";
        }
        return cleaned;
      });

      res.json({ rows, total, limit, offset, columns: validColumns });
    } catch (error) {
      console.error("Error fetching table data:", error);
      res.status(500).json({ error: "데이터 조회에 실패했습니다." });
    }
  });

  app.put("/api/admin/tables/:table/rows/:id", requireDeveloper, async (req, res) => {
    try {
      const table = toSingleString(req.params.table);
      const id = toSingleString(req.params.id);
      if (!ADMIN_TABLE_WHITELIST.includes(table)) {
        return res.status(400).json({ error: "허용되지 않는 테이블입니다." });
      }
      const updates = req.body;
      if (!updates || Object.keys(updates).length === 0) {
        return res.status(400).json({ error: "수정할 데이터가 없습니다." });
      }

      const colCheck = await pool.query(
        `SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name=$1`,
        [table]
      );
      const validColumns = colCheck.rows.map((r: any) => r.column_name);
      const forbiddenColumns = ["id", "password"];
      
      const setClauses: string[] = [];
      const values: any[] = [];
      let paramIndex = 1;
      const encryptedUpdates = encryptRawTablePayload(table, updates);
      for (const [key, value] of Object.entries(encryptedUpdates)) {
        if (!validColumns.includes(key) || forbiddenColumns.includes(key)) continue;
        setClauses.push(`"${key}" = $${paramIndex}`);
        values.push(value === "" ? null : value);
        paramIndex++;
      }

      if (setClauses.length === 0) {
        return res.status(400).json({ error: "유효한 수정 항목이 없습니다." });
      }

      values.push(id);
      await pool.query(
        `UPDATE "${table}" SET ${setClauses.join(", ")} WHERE id = $${paramIndex}`,
        values
      );

      const currentUser = await storage.getUser(req.session.userId!);
      await storage.createSystemLog({
        userId: req.session.userId!,
        loginId: currentUser?.loginId || "",
        userName: currentUser?.name || "Unknown",
        action: `어드민 데이터 수정: ${table}/${id}`,
        actionType: "settings_change",
        ipAddress: (req.headers["x-forwarded-for"] as string) || req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        details: `테이블 ${table}, ID: ${id}, 수정 항목: ${Object.keys(updates).join(", ")}`,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error updating row:", error);
      res.status(500).json({ error: "데이터 수정에 실패했습니다." });
    }
  });

  app.delete("/api/admin/tables/:table/rows/:id", requireDeveloper, async (req, res) => {
    try {
      const table = toSingleString(req.params.table);
      const id = toSingleString(req.params.id);
      if (!ADMIN_TABLE_WHITELIST.includes(table)) {
        return res.status(400).json({ error: "허용되지 않는 테이블입니다." });
      }

      await pool.query(`DELETE FROM "${table}" WHERE id = $1`, [id]);

      const currentUser = await storage.getUser(req.session.userId!);
      await storage.createSystemLog({
        userId: req.session.userId!,
        loginId: currentUser?.loginId || "",
        userName: currentUser?.name || "Unknown",
        action: `어드민 데이터 삭제: ${table}/${id}`,
        actionType: "settings_change",
        ipAddress: (req.headers["x-forwarded-for"] as string) || req.ip || "",
        userAgent: req.headers["user-agent"] || "",
        details: `테이블 ${table}, ID: ${id}`,
      });

      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting row:", error);
      res.status(500).json({ error: "데이터 삭제에 실패했습니다." });
    }
  });

  app.post("/api/admin/sql", requireDeveloper, async (req, res) => {
    try {
      const { query, allowWrite } = req.body;
      if (!query || typeof query !== "string" || query.trim().length === 0) {
        return res.status(400).json({ error: "SQL 쿼리가 비어있습니다." });
      }

      const trimmedQuery = query.trim().toUpperCase();
      const isWriteQuery = /^(INSERT|UPDATE|DELETE|DROP|ALTER|TRUNCATE|CREATE)/i.test(trimmedQuery);

      if (isWriteQuery && !allowWrite) {
        return res.status(400).json({ 
          error: "쓰기 쿼리입니다. 실행하려면 '쓰기 허용'을 체크해주세요.",
          isWriteQuery: true 
        });
      }

      if (/^(DROP|ALTER|TRUNCATE|CREATE)/i.test(trimmedQuery)) {
        return res.status(400).json({ error: "DDL 쿼리(DROP, ALTER, TRUNCATE, CREATE)는 실행할 수 없습니다." });
      }

      const startTime = Date.now();
      const client = await pool.connect();
      try {
        await client.query("SET statement_timeout = '10000'");
        const result = await client.query(query);
        const executionTime = Date.now() - startTime;

        const currentUser = await storage.getUser(req.session.userId!);
        await storage.createSystemLog({
          userId: req.session.userId!,
          loginId: currentUser?.loginId || "",
          userName: currentUser?.name || "Unknown",
          action: "어드민 SQL 실행",
          actionType: "settings_change",
          ipAddress: (req.headers["x-forwarded-for"] as string) || req.ip || "",
          userAgent: req.headers["user-agent"] || "",
          details: `SQL: ${query.substring(0, 500)}`,
        });

        const maxRows = 500;
        const truncated = result.rows && result.rows.length > maxRows;
        const rows = truncated ? result.rows.slice(0, maxRows) : (result.rows || []);

        const sensitiveColumns = ["password"];
        const sanitizedRows = rows.map((row: any) => {
          const cleaned = { ...row };
          for (const col of sensitiveColumns) {
            if (cleaned[col]) cleaned[col] = "********";
          }
          return cleaned;
        });

        res.json({
          rows: sanitizedRows,
          fields: result.fields?.map((f: any) => ({ name: f.name, dataTypeID: f.dataTypeID })) || [],
          rowCount: result.rowCount,
          totalRows: result.rows?.length || 0,
          truncated,
          executionTime,
          command: result.command,
        });
      } finally {
        client.release();
      }
    } catch (error: any) {
      console.error("SQL execution error:", error);
      res.status(400).json({ error: error.message || "SQL 실행 오류" });
    }
  });

  const bulkUpload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

  const hasBulkImportCellValue = (value: unknown) =>
    value !== undefined && value !== null && String(value).trim() !== "";

  const parseBulkImportNumber = (value: unknown, fallback = 0) => {
    if (typeof value === "number") {
      return Number.isFinite(value) ? value : fallback;
    }
    const raw = String(value ?? "").trim();
    if (!raw) return fallback;
    const isParenthesizedNegative = /^\(.*\)$/.test(raw);
    const normalized = raw.replace(/,/g, "").replace(/[₩원\s]/g, "");
    const match = normalized.match(/[+-]?\d+(?:\.\d+)?/);
    if (!match) return fallback;
    const parsed = Number(match[0]);
    if (!Number.isFinite(parsed)) return fallback;
    return isParenthesizedNegative ? -Math.abs(parsed) : parsed;
  };

  const parseBulkImportInteger = (value: unknown, fallback = 0) =>
    Math.round(parseBulkImportNumber(value, fallback));

  const getBulkImportMappedRawValue = (
    rawData: unknown,
    mappingConfig: Record<string, string>,
    targetField: string,
  ) => {
    let rawObject: Record<string, unknown>;
    try {
      rawObject = typeof rawData === "string" ? JSON.parse(rawData || "{}") : {};
    } catch {
      rawObject = {};
    }

    for (const [header, value] of Object.entries(rawObject)) {
      const normalizedHeader = String(header || "").trim();
      if (!normalizedHeader) continue;
      if (mappingConfig[normalizedHeader] === targetField) return value;
      for (const [mappedHeader, field] of Object.entries(mappingConfig)) {
        if (field === targetField && normalizedHeader.startsWith(mappedHeader)) {
          return value;
        }
      }
    }
    return undefined;
  };

  app.post("/api/bulk-import/upload", autoLoginDev, requireAuth, async (req, res, next) => {
    try {
      const currentUser = await storage.getUser(req.session.userId!);
      if (!currentUser || !PERMISSION_ADMIN_ROLES.includes(currentUser.role || "")) {
        return res.status(403).json({ error: "관리자 권한이 필요합니다." });
      }
      next();
    } catch (error) {
      res.status(500).json({ error: "권한 확인 실패" });
    }
  }, bulkUpload.single("file"), async (req, res) => {
    try {
      const currentUser = await storage.getUser(req.session.userId!);
      if (!req.file) {
        return res.status(400).json({ error: "파일이 없습니다." });
      }

      const workbook = XLSX.read(req.file.buffer, { type: "buffer" });

      const selectedSheet = req.body?.sheetName;
      if (!selectedSheet) {
        const sheetList = workbook.SheetNames.map(name => {
          const ws = workbook.Sheets[name];
          const data: any[][] = XLSX.utils.sheet_to_json(ws, { header: 1 });
          let detectedType = "기타";
          if (name.includes("슬롯")) detectedType = "슬롯";
          else if (name.includes("바이럴")) detectedType = "바이럴";
          else if (name.includes("타지역")) detectedType = "타지역";
          return { name, rowCount: Math.max(0, data.length - 1), detectedType };
        });
        return res.json({ sheets: sheetList, needsSelection: true });
      }

      if (!workbook.SheetNames.includes(selectedSheet)) {
        return res.status(400).json({ error: `시트 '${selectedSheet}'을(를) 찾을 수 없습니다.` });
      }

      const sheetName = selectedSheet;
      const worksheet = workbook.Sheets[sheetName];
      const jsonData: any[][] = XLSX.utils.sheet_to_json(worksheet, { header: 1 });

      if (jsonData.length < 2) {
        return res.status(400).json({ error: "데이터가 없습니다." });
      }

      const headers: string[] = jsonData[0].map((h: any) => String(h || "").trim());

      let sheetType = "슬롯";
      if (headers.some(h => h.includes("바이럴")) || sheetName.includes("바이럴")) {
        sheetType = "바이럴";
      } else if (headers.some(h => h.includes("슬롯")) || sheetName.includes("슬롯")) {
        sheetType = "슬롯";
      } else if (sheetName.includes("타지역")) {
        sheetType = "타지역";
      }

      const slotMapping: Record<string, string> = {
        "날짜": "contractDate",
        "요청": "customerName",
        "신청": "customerName",
        "사용자": "userIdentifier",
        "담당자": "managerName",
        "품명": "productName",
        "슬롯": "productName",
        "상품": "productName",
        "단가": "unitPrice",
        "일수": "days",
        "추가": "addQuantity",
        "연장": "extendQuantity",
        "수량": "quantity",
        "결제금액": "cost",
        "총금액": "cost",
        "공급가액": "supplyAmount",
        "공급가": "supplyAmount",
        "부가세": "vatAmount",
        "작업비": "workCost",
        "작업자": "workerName",
        "계산서발행": "invoiceIssued",
        "결제확인": "paymentConfirmed",
        "비고": "notes",
      };

      const viralMapping: Record<string, string> = {
        "날짜": "contractDate",
        "요청": "customerName",
        "신청업체": "customerName",
        "담당자": "managerName",
        "상품": "productName",
        "품명": "productName",
        "단가": "unitPrice",
        "일수": "days",
        "추가": "addQuantity",
        "연장": "extendQuantity",
        "수량": "quantity",
        "총금액": "cost",
        "결제금액": "cost",
        "총금액(공급가)": "cost",
        "공급가액": "supplyAmount",
        "공급가": "supplyAmount",
        "부가세": "vatAmount",
        "작업비": "workCost",
        "작업자": "workerName",
        "계산서발행": "invoiceIssued",
        "결제확인": "paymentConfirmed",
        "비고": "notes",
      };

      const fieldMapping = sheetType === "바이럴" ? viralMapping : slotMapping;

      const headerFieldMap: Record<number, string> = {};
      const usedFields = new Set<string>();
      headers.forEach((header, idx) => {
        if (fieldMapping[header] && !usedFields.has(fieldMapping[header])) {
          headerFieldMap[idx] = fieldMapping[header];
          usedFields.add(fieldMapping[header]);
          return;
        }
      });
      headers.forEach((header, idx) => {
        if (headerFieldMap[idx]) return;
        for (const [korKey, engField] of Object.entries(fieldMapping)) {
          if (!usedFields.has(engField) && header.startsWith(korKey)) {
            headerFieldMap[idx] = engField;
            usedFields.add(engField);
            break;
          }
        }
      });
      const costHeader = headers.find((_, idx) => headerFieldMap[idx] === "cost") || "";
      const costColumnIsSupplyAmount = sheetType === "바이럴" || costHeader.includes("공급가");

      const parseExcelDate = (value: any, fallbackDate: Date | null = null): Date | null => {
        const normalizeDateOnly = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate());
        const safeFallback =
          fallbackDate instanceof Date && !isNaN(fallbackDate.getTime()) ? normalizeDateOnly(fallbackDate) : null;
        const resolveYear = (month: number) => {
          const base = safeFallback || new Date();
          let year = base.getFullYear();
          if (safeFallback) {
            const prevMonth = safeFallback.getMonth() + 1;
            if (prevMonth === 12 && month === 1) year += 1;
          }
          return year;
        };

        if (value === null || value === undefined || value === "") return safeFallback;

        if (value instanceof Date && !isNaN(value.getTime())) {
          return normalizeDateOnly(value);
        }

        if (typeof value === "number" && Number.isFinite(value)) {
          if (value > 1000) {
            const dateCode = XLSX.SSF.parse_date_code(value);
            if (dateCode?.y && dateCode?.m && dateCode?.d) {
              return new Date(dateCode.y, dateCode.m - 1, dateCode.d);
            }
          } else if (value > 0) {
            let month = Math.floor(value);
            let day = Math.round((value - month) * 100);
            if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
              return new Date(resolveYear(month), month - 1, day);
            }

            const compact = Math.round(value);
            if (compact >= 101 && compact <= 1231) {
              month = Math.floor(compact / 100);
              day = compact % 100;
              if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
                return new Date(resolveYear(month), month - 1, day);
              }
            }
          }
          return safeFallback;
        }

        if (typeof value === "string") {
          const text = value.trim();
          if (!text) return safeFallback;

          const normalized = text.replace(/[./]/g, "-").replace(/\s+/g, "");
          const ymd = normalized.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:\s.*)?$/);
          if (ymd) {
            return new Date(parseInt(ymd[1]), parseInt(ymd[2]) - 1, parseInt(ymd[3]));
          }

          const md = normalized.match(/^(\d{1,2})-(\d{1,2})$/);
          if (md) {
            const month = parseInt(md[1]);
            const day = parseInt(md[2]);
            if (month >= 1 && month <= 12 && day >= 1 && day <= 31) {
              return new Date(resolveYear(month), month - 1, day);
            }
          }

          const parsed = new Date(text);
          if (!isNaN(parsed.getTime())) {
            return normalizeDateOnly(parsed);
          }
        }

        return safeFallback;
      };

      const stagingRows: any[] = [];
      let rowIndex = 0;
      let currentContractDate: Date | null = null;

      for (let i = 1; i < jsonData.length; i++) {
        const row = jsonData[i];
        if (!row || row.length === 0 || row.every((cell: any) => !cell && cell !== 0)) continue;

        const mapped: Record<string, any> = {};
        for (const [colIdx, field] of Object.entries(headerFieldMap)) {
          const cellValue = row[parseInt(colIdx)];
          if (cellValue !== undefined && cellValue !== null && cellValue !== "") {
            mapped[field] = cellValue;
          }
        }

        if (!mapped.customerName && !mapped.productName) continue;

        const contractDate = parseExcelDate(mapped.contractDate, currentContractDate);
        if (contractDate) currentContractDate = contractDate;
        const addQuantity = Math.max(0, parseBulkImportInteger(mapped.addQuantity, 0));
        const extendQuantity = Math.max(0, parseBulkImportInteger(mapped.extendQuantity, 0));
        const inferredQuantity = addQuantity + extendQuantity;
        const quantity =
          hasBulkImportCellValue(mapped.quantity)
            ? parseBulkImportInteger(mapped.quantity, 0)
            : inferredQuantity > 0
              ? inferredQuantity
              : 1;
        const paymentConfirmed = mapped.paymentConfirmed ? String(mapped.paymentConfirmed) : null;
        const disbursementStatusFromSheet = mapped.disbursementStatus ? String(mapped.disbursementStatus) : null;
        const disbursementStatus = disbursementStatusFromSheet || paymentConfirmed;
        const unitPrice = parseBulkImportInteger(mapped.unitPrice, 0);
        const days = Math.max(0, parseBulkImportInteger(mapped.days, 0));
        const cost = parseBulkImportInteger(mapped.cost, 0);
        const workCost = Math.max(0, parseBulkImportInteger(mapped.workCost, 0));
        const explicitSupplyAmount = hasBulkImportCellValue(mapped.supplyAmount)
          ? parseBulkImportInteger(mapped.supplyAmount, 0)
          : null;
        const explicitVatAmount = hasBulkImportCellValue(mapped.vatAmount)
          ? parseBulkImportInteger(mapped.vatAmount, 0)
          : null;
        const invoiceIssuedFlag = parseInvoiceIssuedFlag(mapped.invoiceIssued ? String(mapped.invoiceIssued) : null);
        let supplyAmount = explicitSupplyAmount ?? 0;
        let vatAmount = explicitVatAmount ?? 0;
        if (explicitSupplyAmount === null && explicitVatAmount === null) {
          if (cost !== 0) {
            if (!costColumnIsSupplyAmount && invoiceIssuedFlag === true && cost > 0) {
              supplyAmount = Math.round(cost / 1.1);
              vatAmount = cost - supplyAmount;
            } else {
              supplyAmount = cost;
              vatAmount = invoiceIssuedFlag === true ? Math.round(supplyAmount * 0.1) : 0;
            }
          } else if (unitPrice !== 0) {
            supplyAmount = unitPrice * Math.max(1, quantity);
            vatAmount = invoiceIssuedFlag === true ? Math.round(supplyAmount * 0.1) : 0;
          }
        }
        const previewCost = cost !== 0 ? cost : supplyAmount + vatAmount;

        stagingRows.push({
          batchId: "",
          rowIndex: rowIndex++,
          rawData: JSON.stringify(Object.fromEntries(headers.map((h, idx) => [h, row[idx] ?? ""]))),
          contractDate: contractDate,
          customerName: mapped.customerName ? String(mapped.customerName) : null,
          userIdentifier: mapped.userIdentifier ? String(mapped.userIdentifier) : null,
          managerName: mapped.managerName ? String(mapped.managerName) : null,
          productName: mapped.productName ? String(mapped.productName) : null,
          unitPrice,
          days,
          quantity: Math.max(1, quantity),
          cost: previewCost,
          workCost,
          workerName: mapped.workerName ? String(mapped.workerName) : null,
          supplyAmount,
          vatAmount,
          paymentConfirmed,
          invoiceIssued: mapped.invoiceIssued ? String(mapped.invoiceIssued) : null,
          disbursementStatus,
          notes: mapped.notes ? String(mapped.notes) : null,
          errors: null,
          isValid: true,
          isDuplicate: false,
        });
      }

      const batch = await storage.createImportBatch({
        userId: currentUser!.id,
        userName: currentUser!.name,
        fileName: req.file.originalname,
        sheetName: sheetName,
        sheetType: sheetType,
        status: "pending",
        totalRows: stagingRows.length,
        validRows: 0,
        errorRows: 0,
        importedRows: 0,
        mappingConfig: JSON.stringify(fieldMapping),
        errorDetails: null,
        completedAt: null,
      });

      const rowsWithBatchId = stagingRows.map(r => ({ ...r, batchId: batch.id }));
      const createdRows = await storage.createImportStagingRows(rowsWithBatchId);

      await writeSystemLog(req, {
        actionType: "excel_upload",
        action: "일괄등록 엑셀 업로드",
        details: `file=${req.file.originalname}, sheet=${sheetName}, sheetType=${sheetType}, rows=${stagingRows.length}`,
      });

      res.json({
        batch,
        rows: createdRows,
        totalRows: stagingRows.length,
        sheetType,
        sheetName,
        headers,
      });
    } catch (error: any) {
      console.error("Bulk import upload error:", error);
      res.status(500).json({ error: error.message || "파일 업로드 처리 실패" });
    }
  });

  app.get("/api/bulk-import/batches", autoLoginDev, requireAuth, requireAdmin, async (_req, res) => {
    try {
      const batches = await storage.getImportBatches();
      res.json(batches);
    } catch (error) {
      console.error("Error fetching import batches:", error);
      res.status(500).json({ error: "배치 목록 조회 실패" });
    }
  });

  app.get("/api/bulk-import/batches/:batchId", autoLoginDev, requireAuth, requireAdmin, async (req, res) => {
    try {
      const batchId = toSingleString(req.params.batchId);
      const batch = await storage.getImportBatch(batchId);
      if (!batch) {
        return res.status(404).json({ error: "배치를 찾을 수 없습니다." });
      }
      const rows = await storage.getImportStagingRows(batchId);
      res.json({ batch, rows });
    } catch (error) {
      console.error("Error fetching import batch:", error);
      res.status(500).json({ error: "배치 조회 실패" });
    }
  });

  app.post("/api/bulk-import/batches/:batchId/validate", autoLoginDev, requireAuth, requireAdmin, async (req, res) => {
    try {
      const batchId = toSingleString(req.params.batchId);
      const batch = await storage.getImportBatch(batchId);
      if (!batch) {
        return res.status(404).json({ error: "배치를 찾을 수 없습니다." });
      }

      const rows = await storage.getImportStagingRows(batchId);
      let validCount = 0;
      let errorCount = 0;
      const seen = new Set<string>();
      const updatedRows: any[] = [];

      const existingContracts = await storage.getContracts();
      const existingContractKeys = new Set(
        existingContracts.map(c => {
          const dateStr = c.contractDate ? new Date(c.contractDate).toISOString().split("T")[0] : "";
          return `${c.customerName || ""}|${c.products || ""}|${c.userIdentifier || ""}|${dateStr}`;
        })
      );

      for (const row of rows) {
        const errors: string[] = [];

        if (!row.customerName || !row.customerName.trim()) {
          errors.push("고객명 누락");
        }
        if (!row.productName || !row.productName.trim()) {
          errors.push("상품명 누락");
        }

        if (row.contractDate) {
          const d = new Date(row.contractDate);
          if (isNaN(d.getTime())) {
            errors.push("날짜 형식 오류");
          }
        }

        const dupeKey = `${row.customerName || ""}|${row.productName || ""}|${row.userIdentifier || ""}|${row.contractDate ? new Date(row.contractDate).toISOString().split("T")[0] : ""}`;
        let isDuplicate = false;
        if (seen.has(dupeKey)) {
          isDuplicate = true;
          errors.push("배치 내 중복 데이터");
        }
        if (existingContractKeys.has(dupeKey)) {
          isDuplicate = true;
          errors.push("기존 계약과 중복");
        }
        seen.add(dupeKey);

        const isValid = errors.length === 0;
        if (isValid) validCount++;
        else errorCount++;

        updatedRows.push({ ...row, isValid, isDuplicate, errors: errors.length > 0 ? JSON.stringify(errors) : null });
      }

      await storage.deleteImportStagingRows(batchId);
      if (updatedRows.length > 0) {
        await storage.createImportStagingRows(updatedRows.map(r => ({
          batchId: r.batchId,
          rowIndex: r.rowIndex,
          rawData: r.rawData,
          contractDate: r.contractDate,
          customerName: r.customerName,
          userIdentifier: r.userIdentifier,
          managerName: r.managerName,
          productName: r.productName,
          unitPrice: r.unitPrice,
          days: r.days,
          quantity: r.quantity,
          cost: r.cost,
          workCost: r.workCost,
          workerName: r.workerName,
          supplyAmount: r.supplyAmount,
          vatAmount: r.vatAmount,
          paymentConfirmed: r.paymentConfirmed,
          invoiceIssued: r.invoiceIssued,
          disbursementStatus: r.disbursementStatus,
          notes: r.notes,
          errors: r.errors,
          isValid: r.isValid,
          isDuplicate: r.isDuplicate,
        })));
      }

      await storage.updateImportBatch(batchId, {
        status: "validated",
        validRows: validCount,
        errorRows: errorCount,
      });

      const errorList = updatedRows
        .filter(r => !r.isValid && r.errors)
        .map(r => ({
          rowIndex: r.rowIndex,
          errors: JSON.parse(r.errors) as string[],
        }));

      res.json({
        batch: await storage.getImportBatch(batchId),
        validCount,
        errorCount,
        totalRows: rows.length,
        errors: errorList,
        rows: updatedRows,
      });
    } catch (error: any) {
      console.error("Validation error:", error);
      res.status(500).json({ error: error.message || "검증 실패" });
    }
  });

  app.post("/api/bulk-import/batches/:batchId/commit", autoLoginDev, requireAuth, requireAdmin, async (req, res) => {
    try {
      const batchId = toSingleString(req.params.batchId);
      const currentUser = await storage.getUser(req.session.userId!);
      const batch = await storage.getImportBatch(batchId);
      if (!batch) {
        return res.status(404).json({ error: "배치를 찾을 수 없습니다." });
      }

      if (batch.status === "completed") {
        return res.status(400).json({ error: "이미 가져오기가 완료된 배치입니다." });
      }

      const rows = await storage.getImportStagingRows(batchId);
      const validRows = rows.filter(r => r.isValid);

      let importedCount = 0;
      const commitErrors: string[] = [];
      const existingCustomers = await storage.getCustomers();
      const existingProducts = await storage.getProducts();
      const allUsers = await storage.getUsers();
      const customerMap = new Map(existingCustomers.map(c => [c.name, c]));
      const productMap = new Map(existingProducts.map(p => [p.name, p]));
      let importMappingConfig: Record<string, string> = {};
      try {
        importMappingConfig = JSON.parse(batch.mappingConfig || "{}");
      } catch {
        importMappingConfig = {};
      }

      const now = new Date();
      const contractPrefix = `BI${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;

      const isPaymentConfirmed = (val: string | null) => {
        const normalized = normalizeFlagText(val).replace(/\s+/g, "");
        if (!normalized) return false;
        const unconfirmedKeywords = [
          "미확인",
          "미입금",
          "대기",
          "취소",
          "false",
          "0",
          "n",
          "no",
          "x",
        ];
        if (unconfirmedKeywords.some((keyword) => normalized.includes(keyword))) return false;
        return true;
      };

      for (const row of validRows) {
        try {
          await db.transaction(async (tx) => {
            let customer = customerMap.get(row.customerName || "");
            if (!customer && row.customerName) {
              const [createdCustomer] = await tx.insert(customers).values({
                name: row.customerName,
                status: "active",
                customerType: "계약완료",
                lifecycleStage: "customer",
              }).returning();
              customer = createdCustomer;
              customerMap.set(row.customerName, createdCustomer);
            }

            let product = productMap.get(row.productName || "");
            const rowVatType = vatTypeFromInvoiceIssued(row.invoiceIssued);
            if (!product && row.productName) {
              let category = batch.sheetType === "바이럴" ? "바이럴 상품" : "쿠팡슬롯";
              if (row.productName.startsWith("타지역")) {
                category = "타지역팀";
              }
              const [createdProduct] = await tx.insert(products).values({
                name: row.productName,
                category,
                unitPrice: row.unitPrice || 0,
                vatType: rowVatType || "부가세별도",
                isActive: true,
              }).returning();
              product = createdProduct;
              productMap.set(row.productName, createdProduct);
            } else if (product && rowVatType && product.vatType !== rowVatType) {
              const [updatedProduct] = await tx.update(products).set({ vatType: rowVatType }).where(eq(products.id, product.id)).returning();
              if (updatedProduct) {
                product = updatedProduct;
                productMap.set(updatedProduct.name, updatedProduct);
              }
            }

            let supplyAmount = Number(row.supplyAmount) || 0;
            let vatAmount = Number(row.vatAmount) || 0;
            const uploadedCost = Number(row.cost) || 0;
            const rowDays = row.days ? Number(row.days) : 0;
            const addQuantity = 0;
            const extendQuantity = 0;
            const rowQuantity = Math.max(1, Number(row.quantity) || 1);

            if (supplyAmount === 0 && vatAmount === 0 && uploadedCost > 0) {
              supplyAmount = uploadedCost;
            }

            let workerName = row.workerName || null;
            let calculatedWorkCost = row.workCost || 0;
            const matchedProduct = row.productName ? productMap.get(row.productName) : null;
            if (matchedProduct) {
              if (!workerName && matchedProduct.worker) {
                workerName = matchedProduct.worker;
              }
              if (!calculatedWorkCost && matchedProduct.workCost && matchedProduct.baseDays && matchedProduct.baseDays > 0) {
                const dailyWorkCost = matchedProduct.workCost / matchedProduct.baseDays;
                calculatedWorkCost = Math.round(dailyWorkCost * rowDays * rowQuantity);
              }
            }

            const contractNumber = `${contractPrefix}-${String(importedCount + 1).padStart(4, "0")}`;
            const manager = row.managerName ? allUsers.find(u => u.name === row.managerName) : null;
            const paymentStatusText = row.paymentConfirmed ? String(row.paymentConfirmed).trim() : null;
            const disbursementStatus = row.disbursementStatus
              ? String(row.disbursementStatus).trim()
              : paymentStatusText;
            const invoiceIssuedFlag = parseInvoiceIssuedFlag(row.invoiceIssued);
            const productDetailsVatType = invoiceIssuedFlag === true ? "포함" : "미포함";
            if (supplyAmount === 0 && row.unitPrice) {
              supplyAmount = (Number(row.unitPrice) || 0) * rowQuantity;
            }
            if (vatAmount === 0 && invoiceIssuedFlag === true && supplyAmount > 0) {
              vatAmount = Math.round(supplyAmount * 0.1);
            }
            const contractCost = supplyAmount;
            const grossAmount = supplyAmount + vatAmount;
            const productDetails = row.productName
              ? [
                  {
                    id: "1",
                    productName: row.productName,
                    userIdentifier: row.userIdentifier || "",
                    vatType: productDetailsVatType,
                    unitPrice: Number(row.unitPrice) || 0,
                    days: rowDays,
                    addQuantity,
                    extendQuantity,
                    quantity: rowQuantity,
                    baseDays: rowDays,
                    worker: workerName || "",
                    workCost: calculatedWorkCost,
                    fixedWorkCostAmount: null,
                    disbursementStatus,
                    supplyAmount,
                    grossSupplyAmount: grossAmount,
                    refundAmount: null,
                    negativeAdjustmentAmount: null,
                    marginAmount: supplyAmount - calculatedWorkCost,
                  },
                ]
              : [];

            const [contract] = await tx.insert(contracts).values({
              contractNumber,
              contractDate: row.contractDate || now,
              contractName: null,
              managerId: manager?.id || null,
              managerName: row.managerName || "",
              customerId: customer?.id || null,
              customerName: row.customerName || "",
              products: row.productName || "",
              cost: contractCost,
              days: rowDays,
              quantity: rowQuantity,
              addQuantity,
              extendQuantity,
              paymentConfirmed: isPaymentConfirmed(row.paymentConfirmed),
              paymentMethod: paymentStatusText,
              invoiceIssued: row.invoiceIssued || null,
              worker: workerName,
              workCost: calculatedWorkCost,
              notes: row.notes || null,
              disbursementStatus,
              userIdentifier: row.userIdentifier || null,
              productDetailsJson: productDetails.length > 0 ? JSON.stringify(productDetails) : null,
            }).returning();

            if (isPaymentConfirmed(row.paymentConfirmed)) {
              await tx.insert(payments).values({
                contractId: contract.id,
                depositDate: row.contractDate || now,
                customerName: row.customerName || "",
                manager: row.managerName || "",
                amount: grossAmount || uploadedCost || contractCost,
                depositConfirmed: true,
                paymentMethod: paymentStatusText,
                invoiceIssued: invoiceIssuedFlag === true,
                notes: `일괄등록- ${batch.fileName}`,
              });
            }
          });

          importedCount++;
        } catch (rowError: any) {
          commitErrors.push(`행 ${row.rowIndex + 1}: ${rowError.message}`);
        }
      }

      await storage.updateImportBatch(batchId, {
        status: "completed",
        importedRows: importedCount,
        completedAt: new Date(),
        errorDetails: commitErrors.length > 0 ? JSON.stringify(commitErrors) : null,
      });

      if (currentUser) {
        await storage.createSystemLog({
          userId: currentUser.id,
          loginId: currentUser.loginId,
          userName: currentUser.name,
          action: `일괄등록 완료: ${batch.fileName} (${importedCount}건)`,
          actionType: "data_export",
          ipAddress: (req.headers["x-forwarded-for"] as string) || req.ip || "",
          userAgent: req.headers["user-agent"] || "",
        });
      }

      res.json({
        importedCount,
        totalValid: validRows.length,
        errors: commitErrors,
      });
    } catch (error: any) {
      console.error("Commit error:", error);
      res.status(500).json({ error: error.message || "가져오기 실패" });
    }
  });

  app.delete("/api/bulk-import/batches/:batchId", autoLoginDev, requireAuth, requireAdmin, async (req, res) => {
    try {
      const batchId = toSingleString(req.params.batchId);
      const batch = await storage.getImportBatch(batchId);
      if (!batch) {
        return res.status(404).json({ error: "배치를 찾을 수 없습니다." });
      }
      await storage.deleteImportBatch(batchId);
      res.json({ success: true });
    } catch (error) {
      console.error("Error deleting import batch:", error);
      res.status(500).json({ error: "배치 삭제 실패" });
    }
  });

  app.get("/api/bulk-import/template", async (_req, res) => {
    try {
      res.json({
        슬롯: {
          headers: ["날짜", "요청", "사용자", "담당자", "품명", "단가", "일수", "수량", "결제금액", "작업자", "계산서발행", "결제확인", "비고"],
        },
        바이럴: {
          headers: ["날짜", "신청업체", "담당자", "상품", "단가", "일수", "수량", "총금액(공급가)", "작업자", "계산서발행", "결제확인", "비고"],
        },
      });
    } catch (error) {
      console.error("Error fetching template:", error);
      res.status(500).json({ error: "템플릿 조회 실패" });
    }
  });

  return httpServer;
}




