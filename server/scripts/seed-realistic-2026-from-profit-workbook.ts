import fs from "node:fs";
import path from "node:path";
import XLSX from "xlsx";
import { sql } from "drizzle-orm";
import { db, pool } from "../db";
import {
  activities,
  contacts,
  contracts,
  customers,
  dealTimelines,
  deals,
  deposits,
  keeps,
  payments,
  productRateHistories,
  products,
  refunds,
  regionalCustomerLists,
  regionalManagementFees,
  systemLogs,
  users,
} from "@shared/schema";

type SheetRow = Array<unknown>;
type SourceRow = {
  sourceMonth: number;
  date: Date;
  rawCustomer: string;
  rawIdentifier: string;
  rawProduct: string;
  productName: string;
  category: string;
  days: number;
  quantity: number;
  unitPrice: number;
  totalAmount: number;
  worker: string;
  workCost: number;
  note: string;
  bank: string;
  paymentAmount: number;
};

const DEFAULT_EXCEL_PATH = "C:/Users/ksm39/Downloads/crm데이터 정리/★순이익 일일장부 (2025).xlsx";
const DATABASE_URL = process.env.DATABASE_URL || "postgres://crm:crm@127.0.0.1:5432/crmdb";

process.env.DATABASE_URL = DATABASE_URL;

const COMPANY_POOL = [
  "온유커머스",
  "라온디지털",
  "브릿지파트너스",
  "모먼트랩",
  "에이블스토어",
  "하이브마케팅",
  "뉴웨이브컴퍼니",
  "마루기획",
  "픽셀브랜딩",
  "더클릭컴퍼니",
  "루트커머스",
  "코어플러스",
  "센트럴애드",
  "비앤비컴퍼니",
  "위드플레이스",
  "그로스메이트",
  "스튜디오나우",
  "플랜비마케팅",
  "오브제커머스",
  "페어링랩",
  "어반마켓",
  "디에이치커머스",
  "메이크브랜드",
  "에코플로우",
  "클릭온미디어",
  "베러데이즈",
  "프라임커머스",
  "올웨이즈온",
  "리버스튜디오",
  "엔비마케팅",
  "브랜드온",
  "스퀘어랩",
  "그릿커머스",
  "모아애드",
  "퍼스트뷰",
  "오렌지웨이",
  "세븐브릿지",
  "원더커머스",
  "에이치앤컴퍼니",
  "넥스트커머스",
  "포인트랩",
  "제이앤브랜드",
  "비스타마케팅",
  "블루웨이브",
  "스테이브랜드",
  "웨이브온",
  "브라이트컴퍼니",
  "오늘커머스",
];

const LEAD_COMPANY_POOL = [
  "누리커머스",
  "비전브랜드",
  "클로버마케팅",
  "어센트랩",
  "데일리온",
  "브랜드하우스",
  "루미너스컴퍼니",
  "에이든커머스",
  "플로우애드",
  "모스트디지털",
  "큐브마켓",
  "디자인온",
  "헬로브랜드",
  "테라커머스",
];

const MANAGER_POOL = ["김상만", "이도현", "박서준", "정하윤", "최민재", "한지우"];
const WORKER_MAP: Record<string, string> = {
  "슬롯상품": "슬롯운영팀",
  "월 보장 상품": "보장운영팀",
  "바이럴상품": "콘텐츠운영팀",
  "외주 실행 비용": "외주파트너",
  "기타": "운영지원팀",
};

function text(value: unknown): string {
  return String(value ?? "").trim();
}

function amount(value: unknown, fallback = 0): number {
  const parsed = Number(text(value).replace(/,/g, "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? Math.max(0, Math.round(parsed)) : fallback;
}

function positive(value: unknown, fallback = 1): number {
  return Math.max(1, amount(value, fallback));
}

function makeDate(year: number, month: number, day: number): Date {
  return new Date(year, month - 1, Math.max(1, Math.min(day, 28)), 12, 0, 0);
}

function parseSheetDate(raw: unknown, sheetMonth: number): Date | null {
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    return makeDate(2026, sheetMonth, raw.getDate());
  }
  const value = text(raw);
  if (!value) return null;
  const match = value.match(/(\d{1,2})\s*[.월]\s*(\d{1,2})?/);
  if (!match) return null;
  const month = Number(match[1]) || sheetMonth;
  const day = Number(match[2]) || 1;
  return makeDate(2026, month, day);
}

function cleanProductKey(rawProduct: string): string {
  return rawProduct
    .replace(/\s+/g, "")
    .replace(/\d+일/g, "")
    .replace(/\d+/g, "")
    .toUpperCase();
}

function cleanSheetProductName(rawProduct: string): string {
  const cleaned = rawProduct
    .replace(/\s+/g, " ")
    .replace(/\s*\d+\s*일\s*$/g, "")
    .trim();
  return cleaned || "기타";
}

function normalizeProduct(rawProduct: string): { productName: string; category: string } {
  const key = cleanProductKey(rawProduct);
  const productName = cleanSheetProductName(rawProduct);
  if (key.includes("프라다")) return { productName, category: "월 보장 상품" };
  if (key.includes("영수증") || key.includes("리뷰") || key.includes("가구매")) return { productName, category: "바이럴상품" };
  if (key.includes("페이백")) return { productName, category: "외주 실행 비용" };
  if (
    key.includes("BBS") ||
    key.includes("쿠팡") ||
    key.includes("포유") ||
    key.includes("스티젠") ||
    key.includes("베라") ||
    key.includes("DEX") ||
    key.includes("DEEP") ||
    key.includes("DEPP") ||
    key.includes("소보루") ||
    key.includes("자몽") ||
    key.includes("피코") ||
    key.includes("가드")
  ) {
    return { productName, category: "슬롯상품" };
  }
  return { productName, category: "기타" };
}

function timestampLabel(date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
}

function writeJson(filePath: string, data: unknown): void {
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2), "utf-8");
}

function readSourceRows(excelPath: string): SourceRow[] {
  const workbook = XLSX.readFile(excelPath, { cellDates: true });
  const sheetNames = ["26.1월", "26.2월", "26.3월", "26.4월"];
  const rows: SourceRow[] = [];

  for (let sheetIndex = 0; sheetIndex < sheetNames.length; sheetIndex += 1) {
    const sheetName = sheetNames[sheetIndex];
    const worksheet = workbook.Sheets[sheetName];
    if (!worksheet) continue;
    const sheetMonth = sheetIndex + 1;
    const sheetRows = XLSX.utils.sheet_to_json<SheetRow>(worksheet, { header: 1, defval: null, raw: true });
    let currentDate = makeDate(2026, sheetMonth, 1);

    for (const row of sheetRows.slice(3)) {
      const parsedDate = parseSheetDate(row[0], sheetMonth);
      if (parsedDate) currentDate = parsedDate;

      const rawCustomer = text(row[1]);
      const rawProduct = text(row[3]);
      const totalAmount = amount(row[8]);
      if (!rawCustomer || !rawProduct || totalAmount <= 0) continue;

      const normalized = normalizeProduct(rawProduct);
      const addQuantity = amount(row[5]);
      const extendQuantity = amount(row[6]);
      const quantity = Math.max(1, addQuantity + extendQuantity || 1);
      const days = positive(row[4], normalized.category === "월 보장 상품" ? 30 : 10);
      const unitPrice = amount(row[7], Math.round(totalAmount / quantity));
      const workCost = amount(row[11], Math.round(totalAmount * 0.65));

      rows.push({
        sourceMonth: sheetMonth,
        date: currentDate,
        rawCustomer,
        rawIdentifier: text(row[2]),
        rawProduct,
        productName: normalized.productName,
        category: normalized.category,
        days,
        quantity,
        unitPrice,
        totalAmount,
        worker: text(row[9]) || WORKER_MAP[normalized.category] || "운영지원팀",
        workCost,
        note: text(row[13]),
        bank: text(row[16]) || (rows.length % 2 === 0 ? "하나" : "국민"),
        paymentAmount: amount(row[17]),
      });
    }
  }

  return rows;
}

function chooseMonthlyRows(sourceRows: SourceRow[], targetMonth: number, limit = 22): SourceRow[] {
  const baseMonth = targetMonth <= 4 ? targetMonth : targetMonth - 2;
  const candidates = sourceRows.filter((row) => row.sourceMonth === baseMonth);
  const buckets = ["슬롯상품", "월 보장 상품", "바이럴상품", "외주 실행 비용", "기타"];
  const selected: SourceRow[] = [];

  for (const bucket of buckets) {
    const bucketRows = candidates.filter((row) => row.category === bucket);
    const take = bucket === "슬롯상품" ? 12 : bucket === "월 보장 상품" ? 4 : bucket === "바이럴상품" ? 4 : 1;
    for (let i = 0; i < Math.min(take, bucketRows.length); i += 1) {
      selected.push(bucketRows[(i * 7 + targetMonth) % bucketRows.length]);
    }
  }

  for (let i = 0; selected.length < limit && i < candidates.length; i += 9) {
    selected.push(candidates[(i + targetMonth) % candidates.length]);
  }

  return selected.slice(0, limit).map((row, index) => ({
    ...row,
    date: makeDate(2026, targetMonth, ((index * 3 + row.date.getDate()) % 26) + 1),
  }));
}

function makeCompanyName(index: number): string {
  return COMPANY_POOL[index % COMPANY_POOL.length];
}

function makeCampaignCode(month: number, index: number, productName: string): string {
  const prefix = productName.includes("리뷰") ? "review" : productName.includes("월보장") ? "mg" : "slot";
  return `${prefix}-${String(month).padStart(2, "0")}-${String(index + 1).padStart(3, "0")}`;
}

function depositStatus(index: number): "confirmed" | "partial" | "pending" {
  if (index % 11 === 0) return "pending";
  if (index % 7 === 0) return "partial";
  return "confirmed";
}

async function backupTables(backupRoot: string): Promise<Record<string, number>> {
  fs.mkdirSync(backupRoot, { recursive: true });
  const tableMap = {
    systemLogs,
    dealTimelines,
    regionalCustomerLists,
    regionalManagementFees,
    activities,
    payments,
    refunds,
    keeps,
    deposits,
    contacts,
    deals,
    contracts,
    productRateHistories,
    customers,
    products,
  };
  const counts: Record<string, number> = {};
  for (const [name, table] of Object.entries(tableMap)) {
    const rows = await db.select().from(table as never);
    counts[name] = rows.length;
    writeJson(path.join(backupRoot, `${name}.json`), rows);
  }
  return counts;
}

async function main() {
  const excelPath = process.argv[2] || DEFAULT_EXCEL_PATH;
  if (!fs.existsSync(excelPath)) throw new Error(`Excel file not found: ${excelPath}`);

  const sourceRows = readSourceRows(excelPath);
  if (sourceRows.length === 0) throw new Error("No usable 2026 rows found in workbook.");

  const backupRoot = path.join(process.cwd(), "backups", `realistic_2026_pre_reset_${timestampLabel()}`);
  const beforeCounts = await backupTables(backupRoot);
  const dbUsers = await db.select().from(users);
  const userByName = new Map(dbUsers.map((user) => [String(user.name || "").trim(), user]));

  const productStats = new Map<string, { category: string; unitPrices: number[]; workCosts: number[]; baseDays: number[]; worker: string }>();
  const generatedRows = Array.from({ length: 6 }, (_, i) => chooseMonthlyRows(sourceRows, i + 1)).flat();
  for (const row of generatedRows) {
    const stat = productStats.get(row.productName) || {
      category: row.category,
      unitPrices: [],
      workCosts: [],
      baseDays: [],
      worker: row.worker,
    };
    stat.unitPrices.push(row.unitPrice);
    stat.workCosts.push(Math.max(0, Math.round(row.workCost / Math.max(1, row.quantity))));
    stat.baseDays.push(row.days);
    productStats.set(row.productName, stat);
  }

  const median = (values: number[], fallback: number) => {
    const sorted = values.filter((value) => value > 0).sort((a, b) => a - b);
    if (sorted.length === 0) return fallback;
    return sorted[Math.floor(sorted.length / 2)];
  };

  let insertedCustomers = 0;
  let insertedLeads = 0;
  let insertedProducts = 0;
  let insertedContracts = 0;
  let insertedDeposits = 0;
  let insertedPayments = 0;
  let insertedRefunds = 0;

  await db.transaction(async (tx) => {
    await tx.delete(systemLogs);
    await tx.delete(dealTimelines);
    await tx.delete(regionalCustomerLists);
    await tx.delete(regionalManagementFees);
    await tx.delete(activities);
    await tx.delete(payments);
    await tx.delete(refunds);
    await tx.delete(keeps);
    await tx.delete(deposits);
    await tx.delete(contacts);
    await tx.delete(deals);
    await tx.delete(contracts);
    await tx.delete(productRateHistories);
    await tx.delete(customers);
    await tx.delete(products);

    const productIdByName = new Map<string, string>();
    for (const [productName, stat] of Array.from(productStats.entries())) {
      const unitPrice = median(stat.unitPrices, 100000);
      const workCost = median(stat.workCosts, Math.round(unitPrice * 0.65));
      const baseDays = median(stat.baseDays, stat.category === "월 보장 상품" ? 30 : 10);
      const [product] = await tx.insert(products).values({
        name: productName,
        category: stat.category,
        unitPrice,
        unit: stat.category === "바이럴상품" ? "건" : "일",
        baseDays,
        workCost,
        purchasePrice: workCost,
        vatType: "부가세별도",
        worker: stat.worker,
        notes: "2026년 가명 샘플 데이터",
        isActive: true,
      }).returning({ id: products.id });
      productIdByName.set(productName, product.id);
      insertedProducts += 1;
      await tx.insert(productRateHistories).values({
        productId: product.id,
        productName,
        effectiveFrom: makeDate(2026, 1, 1),
        unitPrice,
        workCost,
        baseDays,
        vatType: "부가세별도",
        worker: stat.worker,
        changedBy: "seed-realistic-2026",
      });
    }

    const customerIdByName = new Map<string, string>();
    for (let i = 0; i < COMPANY_POOL.length; i += 1) {
      const companyName = makeCompanyName(i);
      const managerName = MANAGER_POOL[i % MANAGER_POOL.length];
      const [customer] = await tx.insert(customers).values({
        name: companyName,
        company: companyName,
        email: `contact${String(i + 1).padStart(2, "0")}@example-crm.test`,
        phone: `010-${String(4300 + i).padStart(4, "0")}-${String(1200 + i).padStart(4, "0")}`,
        status: "active",
        customerType: "계약완료",
        customerCategory: "일반고객",
        serviceType: i % 5 === 0 ? "월보장" : i % 4 === 0 ? "바이럴" : "슬롯",
        managerName,
        lifecycleStage: "customer",
        notes: "2026년 고객사 샘플",
      }).returning({ id: customers.id });
      customerIdByName.set(companyName, customer.id);
      insertedCustomers += 1;
    }

    for (let i = 0; i < 14; i += 1) {
      const companyName = LEAD_COMPANY_POOL[i % LEAD_COMPANY_POOL.length];
      await tx.insert(customers).values({
        name: companyName,
        company: companyName,
        email: `lead${String(i + 1).padStart(2, "0")}@example-crm.test`,
        phone: `010-${String(5100 + i).padStart(4, "0")}-${String(2200 + i).padStart(4, "0")}`,
        status: "active",
        customerType: "가망",
        customerCategory: "일반고객",
        serviceType: i % 3 === 0 ? "월보장" : i % 3 === 1 ? "슬롯" : "바이럴",
        managerName: MANAGER_POOL[i % MANAGER_POOL.length],
        lifecycleStage: "lead",
        notes: "상담 진행 중",
      });
      insertedLeads += 1;
    }

    for (let index = 0; index < generatedRows.length; index += 1) {
      const row = generatedRows[index];
      const month = row.date.getMonth() + 1;
      const customerName = makeCompanyName(index);
      const customerId = customerIdByName.get(customerName)!;
      const managerName = MANAGER_POOL[index % MANAGER_POOL.length];
      const manager = userByName.get(managerName);
      const status = depositStatus(index);
      const refundAmount = index % 13 === 0 ? Math.round(row.totalAmount * 0.2) : 0;
      const confirmedAmount = status === "confirmed"
        ? Math.max(0, row.totalAmount - refundAmount)
        : status === "partial"
          ? Math.round(Math.max(0, row.totalAmount - refundAmount) * 0.6)
          : 0;
      const paymentMethod = status === "pending" ? "입금전" : row.bank.includes("국민") ? "국민" : "하나";
      const contractNumber = `EL-2026${String(month).padStart(2, "0")}-${String(index + 1).padStart(4, "0")}`;
      const userIdentifier = makeCampaignCode(month, index, row.productName);
      const productDetailsJson = JSON.stringify([{
        id: "item-1",
        productName: row.productName,
        userIdentifier,
        days: row.days,
        addQuantity: row.quantity,
        extendQuantity: 0,
        quantity: row.quantity,
        unitPrice: Math.max(0, Math.round(row.totalAmount / Math.max(1, row.quantity))),
        baseDays: row.days,
        worker: row.worker,
        workCost: Math.max(0, Math.round(row.workCost / Math.max(1, row.quantity))),
        vatType: "부가세별도",
        disbursementStatus: status === "pending" ? "입금전" : "입금완료",
      }]);

      const [contract] = await tx.insert(contracts).values({
        contractNumber,
        contractDate: row.date,
        contractName: `${row.productName} 운영`,
        managerId: manager?.id || null,
        managerName,
        customerId,
        customerName,
        products: row.productName,
        cost: row.totalAmount,
        days: row.days,
        quantity: row.quantity,
        addQuantity: row.quantity,
        extendQuantity: 0,
        paymentConfirmed: status === "confirmed",
        paymentMethod,
        depositBank: paymentMethod === "입금전" ? null : paymentMethod,
        invoiceIssued: "미포함",
        worker: row.worker,
        workCost: row.workCost,
        notes: refundAmount > 0 ? "일부 환불 처리" : "정상 운영",
        disbursementStatus: status === "pending" ? "입금전" : "입금완료",
        executionPaymentStatus: index % 4 === 0 ? "입금전" : "입금완료",
        userIdentifier,
        productDetailsJson,
        contractType: null,
      }).returning({ id: contracts.id });
      insertedContracts += 1;

      await tx.insert(deposits).values({
        depositDate: new Date(row.date.getFullYear(), row.date.getMonth(), Math.min(row.date.getDate() + 3, 28), 12, 0, 0),
        depositorName: customerName,
        depositAmount: confirmedAmount,
        depositBank: paymentMethod === "입금전" ? "미입금" : paymentMethod,
        notes: status === "partial" ? "부분 입금" : status === "pending" ? "입금 예정" : "입금 확인",
        confirmedAmount,
        totalContractAmount: Math.max(0, row.totalAmount - refundAmount),
        contractId: contract.id,
        confirmedBy: confirmedAmount > 0 ? "seed-realistic-2026" : null,
        confirmedAt: confirmedAmount > 0 ? new Date(row.date.getFullYear(), row.date.getMonth(), Math.min(row.date.getDate() + 3, 28), 12, 0, 0) : null,
      });
      insertedDeposits += 1;

      await tx.insert(payments).values({
        contractId: contract.id,
        depositDate: row.date,
        customerName,
        manager: managerName,
        amount: row.totalAmount,
        depositConfirmed: confirmedAmount >= Math.max(0, row.totalAmount - refundAmount),
        paymentMethod,
        invoiceIssued: false,
        notes: "2026년 가명 매출관리 데이터",
      });
      insertedPayments += 1;

      if (refundAmount > 0) {
        const refundDays = Math.min(10, row.days);
        const refundWorkCost = Math.round(row.workCost * (refundAmount / Math.max(1, row.totalAmount)));
        const refundDate = new Date(row.date.getFullYear(), row.date.getMonth(), Math.min(row.date.getDate() + 10, 28), 12, 0, 0);
        const refundDetailsJson = JSON.stringify([{
          id: `refund-item-1-${String(index + 1).padStart(4, "0")}`,
          productName: row.productName,
          userIdentifier,
          vatType: "부가세별도",
          unitPrice: Math.round(row.totalAmount / Math.max(1, row.quantity)),
          days: -refundDays,
          addQuantity: 1,
          extendQuantity: 0,
          quantity: 1,
          worker: row.worker,
          workCost: Math.round(row.workCost / Math.max(1, row.quantity)),
          fixedWorkCostAmount: -refundWorkCost,
          supplyAmount: -refundAmount,
          marginAmount: -refundAmount + refundWorkCost,
          adjustmentType: "refund",
          sourceContractId: contract.id,
          sourceItemId: "item-1",
          refundReason: "운영 일정 조정",
        }]);
        await tx.insert(contracts).values({
          contractNumber: `${contractNumber}-RF-${String(index + 1).padStart(4, "0")}`,
          contractDate: refundDate,
          contractName: null,
          managerId: manager?.id || null,
          managerName,
          customerId,
          customerName,
          products: row.productName,
          cost: -refundAmount,
          days: -refundDays,
          quantity: 1,
          addQuantity: 1,
          extendQuantity: 0,
          paymentConfirmed: false,
          paymentMethod: "환불요청",
          depositBank: paymentMethod === "입금전" ? null : paymentMethod,
          invoiceIssued: "미포함",
          worker: row.worker,
          workCost: -refundWorkCost,
          notes: `환불 계약 / 원계약번호: ${contractNumber} / 사유: 운영 일정 조정`,
          disbursementStatus: "",
          executionPaymentStatus: "입금전",
          userIdentifier,
          productDetailsJson: refundDetailsJson,
          contractType: "refund",
          sourceContractId: contract.id,
          sourceItemId: "item-1",
        });
        insertedRefunds += 1;
      }
    }

    await tx.insert(systemLogs).values({
      userId: null,
      loginId: "seed-realistic-2026",
      userName: "자비스 데이터 적재",
      action: "2026년 가명 샘플 데이터 적재",
      actionType: "data_import",
      ipAddress: "127.0.0.1",
      userAgent: "server-script",
      details: `contracts=${insertedContracts}, customers=${insertedCustomers}, leads=${insertedLeads}, products=${insertedProducts}`,
    });
  });

  const countTable = async (table: Parameters<typeof db.select>[0] extends never ? never : any) => {
    const result = await db.select({ count: sql<number>`count(*)` }).from(table);
    return Number((result[0] as { count?: number } | undefined)?.count || 0);
  };
  const afterCounts = {
    customers: await countTable(customers as never),
    products: await countTable(products as never),
    contracts: await countTable(contracts as never),
    deposits: await countTable(deposits as never),
    payments: await countTable(payments as never),
    refunds: await countTable(refunds as never),
    systemLogs: await countTable(systemLogs as never),
  };

  const monthly = await db.execute(sql`
    select to_char(contract_date, 'YYYY-MM') as month,
           count(*)::int as contracts,
           coalesce(sum(cost), 0)::int as sales,
           coalesce(sum(work_cost), 0)::int as work_cost
    from contracts
    group by 1
    order by 1
  `);

  const summary = {
    excelPath,
    backupRoot,
    sourceRows: sourceRows.length,
    generatedRows: generatedRows.length,
    inserted: {
      customers: insertedCustomers,
      leads: insertedLeads,
      products: insertedProducts,
      contracts: insertedContracts,
      deposits: insertedDeposits,
      payments: insertedPayments,
      refunds: insertedRefunds,
    },
    beforeCounts,
    afterCounts,
    monthly: monthly.rows,
    generatedAt: new Date().toISOString(),
  };

  writeJson(path.join(backupRoot, "SEED_SUMMARY.json"), summary);
  console.log(JSON.stringify(summary, null, 2));
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await pool.end();
  });
