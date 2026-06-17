import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import {
  BarChart3,
  Box,
  CalendarDays,
  CircleDollarSign,
  RefreshCw,
  RotateCcw,
  Search,
  Sparkles,
  Target,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { DatePeriodFilter } from "@/components/date-period-filter";
import { useAuth } from "@/lib/auth";
import type { User } from "@shared/schema";

type ContractItem = {
  id?: string | number | null;
  productName?: string | null;
  days?: number | string | null;
  quantity?: number | string | null;
  addQuantity?: number | string | null;
  extendQuantity?: number | string | null;
  baseDays?: number | string | null;
  workCost?: number | string | null;
  fixedWorkCostAmount?: number | string | null;
  supplyAmount?: number | string | null;
  marginAmount?: number | string | null;
};

type ContractRow = {
  id: string;
  customerName?: string | null;
  companyName?: string | null;
  products?: string | null;
  manager?: string | null;
  managerId?: string | null;
  managerName?: string | null;
  contractDate?: string | Date | null;
  contractStartDate?: string | Date | null;
  cost?: number | string | null;
  totalAmount?: number | string | null;
  workCost?: number | string | null;
  days?: number | string | null;
  quantity?: number | string | null;
  productDetailsJson?: string | null;
  contractType?: string | null;
  contractStatus?: string | null;
  paymentConfirmed?: boolean | null;
  paymentMethod?: string | null;
  executionPaymentStatus?: string | null;
};

type DealRow = {
  id: string;
  productName?: string | null;
  productId?: string | null;
  lineCount?: number | string | null;
  cancelledLineCount?: number | string | null;
  status?: string | null;
  stage?: string | null;
  createdAt?: string | Date | null;
  inboundDate?: string | Date | null;
  contractDate?: string | Date | null;
  contractStartDate?: string | Date | null;
  contractEndDate?: string | Date | null;
};

type RefundRow = {
  id: string;
  contractId?: string | null;
  amount?: number | string | null;
  refundAmount?: number | string | null;
  refundDate?: string | Date | null;
  createdAt?: string | Date | null;
  managerName?: string | null;
};

type ProductRow = {
  id: string;
  name?: string | null;
  category?: string | null;
};

type MetricCard = {
  label: string;
  value: string;
  description: string;
  accent: string;
  icon: typeof CircleDollarSign;
};

function toKoreanDate(value: unknown): Date | null {
  if (!value) return null;
  const date = value instanceof Date ? value : new Date(String(value));
  return Number.isNaN(date.getTime()) ? null : date;
}

function toDateKey(value: unknown): string {
  const date = toKoreanDate(value);
  if (!date) return "";
  const formatter = new Intl.DateTimeFormat("ko-KR", {
    timeZone: "Asia/Seoul",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
  const parts = formatter.formatToParts(date);
  const year = parts.find((part) => part.type === "year")?.value ?? "";
  const month = parts.find((part) => part.type === "month")?.value ?? "";
  const day = parts.find((part) => part.type === "day")?.value ?? "";
  return year && month && day ? `${year}-${month}-${day}` : "";
}

function toMonthKey(value: unknown): string {
  return toDateKey(value).slice(0, 7);
}

type PeriodFilter = "custom" | "yesterday" | "today" | "lastWeek" | "lastMonth" | "thisMonth" | "lastYear" | "thisYear";

function dateFromKey(dateKey: string): Date {
  const [year, month, day] = dateKey.split("-").map((part) => Number(part));
  return new Date(year, (month || 1) - 1, day || 1);
}

function addDays(date: Date, amount: number): Date {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function getWeekStart(date: Date): Date {
  const next = new Date(date);
  const day = next.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  next.setDate(next.getDate() + diff);
  return next;
}

function getRelativeDateRange(filter: PeriodFilter, todayKey: string): { startDate: string; endDate: string } {
  const today = dateFromKey(todayKey);
  if (filter === "yesterday") {
    const target = addDays(today, -1);
    return { startDate: toDateKey(target), endDate: toDateKey(target) };
  }
  if (filter === "today") return { startDate: todayKey, endDate: todayKey };

  const thisWeekStart = getWeekStart(today);
  if (filter === "lastWeek") {
    const start = addDays(thisWeekStart, -7);
    return { startDate: toDateKey(start), endDate: toDateKey(addDays(start, 6)) };
  }
  const year = today.getFullYear();
  const month = today.getMonth();
  if (filter === "lastMonth") {
    return { startDate: toDateKey(new Date(year, month - 1, 1)), endDate: toDateKey(new Date(year, month, 0)) };
  }
  if (filter === "thisMonth" || filter === "custom") {
    return { startDate: toDateKey(new Date(year, month, 1)), endDate: todayKey };
  }
  if (filter === "lastYear") {
    return { startDate: `${year - 1}-01-01`, endDate: `${year - 1}-12-31` };
  }
  return { startDate: `${year}-01-01`, endDate: todayKey };
}

function toAmount(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const parsed = Number(String(value ?? "").replace(/[^\d.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}

function toNonNegativeAmount(value: unknown): number {
  return Math.max(toAmount(value), 0);
}

function formatAmount(value: number): string {
  return Math.round(value).toLocaleString("ko-KR");
}

function formatCurrency(value: number): string {
  return `${formatAmount(value)}원`;
}

function formatCount(value: number, unit = "건"): string {
  return `${formatAmount(value)}${unit}`;
}

function parseProductItems(contract: ContractRow): ContractItem[] {
  const raw = String(contract.productDetailsJson || "").trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item === "object") : [];
  } catch {
    return [];
  }
}

function getContractDate(contract: ContractRow): unknown {
  return contract.contractDate || contract.contractStartDate;
}

function getDealDate(deal: DealRow): unknown {
  return deal.contractDate || deal.contractStartDate || deal.inboundDate || deal.createdAt;
}

function getContractProductNames(contract: ContractRow): string[] {
  const itemNames = parseProductItems(contract)
    .map((item) => String(item.productName || "").trim())
    .filter(Boolean);
  const productNames = String(contract.products || "")
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  return Array.from(new Set([...itemNames, ...productNames]));
}

function isRefundContract(contract: ContractRow): boolean {
  return String(contract.contractType || "").toLowerCase() === "refund" || toAmount(contract.cost) < 0;
}

function isWithdrawnContract(contract: ContractRow): boolean {
  return String(contract.contractStatus || "").trim().toLowerCase() === "withdrawn";
}

function isSlotProduct(name: string): boolean {
  return name.replace(/\s+/g, "").includes("슬롯");
}

function isViralProduct(name: string): boolean {
  return name.replace(/\s+/g, "").includes("바이럴");
}

function isMonthlyGuaranteeText(value: unknown): boolean {
  return normalizeProductKey(value).includes("월보장");
}

function normalizeProductKey(value: unknown): string {
  return String(value || "").replace(/\s+/g, "").trim();
}

function getBaseProductKey(value: unknown): string {
  return normalizeProductKey(String(value || "").replace(/\s*\([^)]*\)\s*$/, ""));
}

function buildProductMap(products: ProductRow[]): Map<string, ProductRow> {
  const map = new Map<string, ProductRow>();
  for (const product of products) {
    const nameKey = normalizeProductKey(product.name);
    const baseKey = getBaseProductKey(product.name);
    if (nameKey) map.set(nameKey, product);
    if (baseKey) map.set(baseKey, product);
  }
  return map;
}

function resolveProduct(productName: unknown, productByName: Map<string, ProductRow>): ProductRow | undefined {
  return productByName.get(normalizeProductKey(productName)) || productByName.get(getBaseProductKey(productName));
}

function isSlotProductByCategory(productName: unknown, productByName: Map<string, ProductRow>): boolean {
  const product = resolveProduct(productName, productByName);
  return normalizeProductKey(product?.category).includes("슬롯");
}

function isMonthlyGuaranteeProduct(productName: unknown, productByName: Map<string, ProductRow>): boolean {
  const product = resolveProduct(productName, productByName);
  return isMonthlyGuaranteeText(productName) || isMonthlyGuaranteeText(product?.category);
}

function getItemQuantity(item: ContractItem, contract?: ContractRow): number {
  const quantity = Math.max(0, Math.round(toAmount(item.quantity)));
  if (quantity > 0) return quantity;
  const splitQuantity =
    Math.max(0, Math.round(toAmount(item.addQuantity))) +
    Math.max(0, Math.round(toAmount(item.extendQuantity)));
  if (splitQuantity > 0) return splitQuantity;
  return Math.max(1, Math.round(toAmount(contract?.quantity) || 1));
}

function getContractSalesAmount(contract: ContractRow): number {
  if (isWithdrawnContract(contract)) return 0;
  if (isRefundContract(contract)) return 0;
  const items = parseProductItems(contract);
  const itemSupply = items.reduce((sum, item) => sum + toAmount(item.supplyAmount), 0);
  if (itemSupply > 0) return itemSupply;
  return toNonNegativeAmount(contract.cost ?? contract.totalAmount);
}

function getStoredItemWorkCost(item: ContractItem): number {
  const fixedWorkCostAmount = toNonNegativeAmount(item.fixedWorkCostAmount);
  if (fixedWorkCostAmount > 0) return fixedWorkCostAmount;

  const supplyAmount = toAmount(item.supplyAmount);
  const marginAmount = toAmount(item.marginAmount);
  if (supplyAmount > 0 && Number.isFinite(marginAmount)) {
    return Math.max(0, supplyAmount - marginAmount);
  }

  return 0;
}

function getContractWorkCost(contract: ContractRow): number {
  if (isWithdrawnContract(contract)) return 0;
  if (isRefundContract(contract)) return 0;
  const items = parseProductItems(contract);
  const storedItemWorkCost = items.reduce((sum, item) => sum + getStoredItemWorkCost(item), 0);
  if (storedItemWorkCost > 0) return storedItemWorkCost;

  const storedContractWorkCost = toNonNegativeAmount(contract.workCost);
  if (storedContractWorkCost > 0) return storedContractWorkCost;

  return items.reduce((sum, item) => {
    const workerUnitCost = toNonNegativeAmount(item.workCost);
    if (workerUnitCost <= 0) return sum;

    const workerBaseDays = Math.max(1, Math.round(toAmount(item.baseDays)) || 1);
    const days = Math.max(1, Math.round(toAmount(item.days || contract.days)) || 1);
    const quantity = getItemQuantity(item, contract);
    return sum + Math.round((workerUnitCost / workerBaseDays) * days * quantity);
  }, 0);
}

function getContractSlotDays(contract: ContractRow, productByName: Map<string, ProductRow>): number {
  if (isWithdrawnContract(contract)) return 0;
  if (isRefundContract(contract)) return 0;
  const items = parseProductItems(contract);
  if (items.length > 0) {
    return items
      .filter((item) => isSlotProductByCategory(item.productName, productByName))
      .reduce((sum, item) => {
        const days = toNonNegativeAmount(item.days || contract.days);
        const quantity = getItemQuantity(item, contract);
        return sum + days * quantity;
      }, 0);
  }
  const productNames = getContractProductNames(contract).filter((name) =>
    isSlotProductByCategory(name, productByName),
  );
  if (productNames.length === 0) return 0;
  return toNonNegativeAmount(contract.days) * Math.max(1, toNonNegativeAmount(contract.quantity));
}

function getRefundAmount(refund: RefundRow): number {
  return toNonNegativeAmount(refund.refundAmount ?? refund.amount);
}

function isWithinDateRange(dateValue: unknown, startDate: string, endDate: string): boolean {
  const dateKey = toDateKey(dateValue);
  if (!dateKey) return false;
  return dateKey >= startDate && dateKey <= endDate;
}

function fetchJson<T>(url: string): Promise<T> {
  return fetch(url, { credentials: "include", cache: "no-store" }).then((response) => {
    if (!response.ok) throw new Error(`Failed to fetch ${url}`);
    return response.json();
  });
}

export default function SalesAnalyticsPage() {
  const { user: currentUser } = useAuth();
  const todayKey = toDateKey(new Date());
  const [startDate, setStartDate] = useState(`${todayKey.slice(0, 8)}01`);
  const [endDate, setEndDate] = useState(todayKey);
  const [periodFilter, setPeriodFilter] = useState<PeriodFilter>("thisMonth");
  const [searchTerm, setSearchTerm] = useState("");
  const [managerFilter, setManagerFilter] = useState("all");
  const [chartYear, setChartYear] = useState(todayKey.slice(0, 4));

  const { data: contracts = [], refetch: refetchContracts } = useQuery<ContractRow[]>({
    queryKey: ["/api/contracts-with-financials"],
    queryFn: () => fetchJson<ContractRow[]>("/api/contracts-with-financials"),
  });
  const { data: deals = [], refetch: refetchDeals } = useQuery<DealRow[]>({
    queryKey: ["/api/deals"],
    queryFn: () => fetchJson<DealRow[]>("/api/deals"),
  });
  const { data: refunds = [], refetch: refetchRefunds } = useQuery<RefundRow[]>({
    queryKey: ["/api/refunds"],
    queryFn: () => fetchJson<RefundRow[]>("/api/refunds"),
  });
  const { data: products = [], refetch: refetchProducts } = useQuery<ProductRow[]>({
    queryKey: ["/api/products"],
    queryFn: () => fetchJson<ProductRow[]>("/api/products"),
  });
  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    queryFn: () => fetchJson<User[]>("/api/users"),
  });

  const productByName = useMemo(() => buildProductMap(products), [products]);
  const isManagerUser = String(currentUser?.role || "").trim() === "매니저";

  const isOwnManagedContract = (contract: ContractRow) => {
    const currentUserId = String(currentUser?.id || "").trim();
    const currentUserName = String(currentUser?.name || "").trim();
    const managerId = String(contract.managerId || "").trim();
    const managerName = String(contract.managerName || contract.manager || "").trim();
    return (!!currentUserId && managerId === currentUserId) || (!!currentUserName && managerName === currentUserName);
  };

  const accessibleContracts = useMemo(() => {
    const activeContracts = contracts.filter((contract) => !isWithdrawnContract(contract));
    if (!isManagerUser) return activeContracts;
    return activeContracts.filter(isOwnManagedContract);
  }, [contracts, currentUser?.id, currentUser?.name, isManagerUser]);

  const accessibleContractIds = useMemo(
    () => new Set(accessibleContracts.map((contract) => contract.id)),
    [accessibleContracts],
  );

  const accessibleRefunds = useMemo(() => {
    if (!isManagerUser) return refunds;
    const currentUserName = String(currentUser?.name || "").trim();
    return refunds.filter((refund) => {
      if (refund.contractId && accessibleContractIds.has(refund.contractId)) return true;
      return !!currentUserName && String(refund.managerName || "").trim() === currentUserName;
    });
  }, [accessibleContractIds, currentUser?.name, isManagerUser, refunds]);

  const managerOptions = useMemo(() => {
    if (isManagerUser && currentUser?.name) return [currentUser.name];
    const names = new Set(
      users
        .map((user) => String(user.name || "").trim())
        .filter(Boolean),
    );
    return Array.from(names).sort((a, b) => a.localeCompare(b, "ko"));
  }, [currentUser?.name, isManagerUser, users]);

  const filteredContracts = useMemo(() => {
    const keyword = searchTerm.trim().toLowerCase();
    return accessibleContracts.filter((contract) => {
      if (!isWithinDateRange(getContractDate(contract), startDate, endDate)) return false;
      const manager = String(contract.managerName || contract.manager || "").trim();
      if (managerFilter !== "all" && manager !== managerFilter) return false;
      const names = getContractProductNames(contract);
      if (!keyword) return true;
      return [
        contract.customerName,
        contract.companyName,
        contract.products,
        contract.managerName,
        contract.manager,
        ...names,
      ].some((value) => String(value || "").toLowerCase().includes(keyword));
    });
  }, [accessibleContracts, endDate, managerFilter, productByName, searchTerm, startDate]);

  const filteredRefunds = useMemo(() => {
    const filteredContractIds = new Set(filteredContracts.map((contract) => contract.id));
    return accessibleRefunds.filter((refund) => {
      if (!isWithinDateRange(refund.refundDate || refund.createdAt, startDate, endDate)) return false;
      if (managerFilter === "all") return true;
      if (String(refund.managerName || "").trim() === managerFilter) return true;
      return !!refund.contractId && filteredContractIds.has(refund.contractId);
    });
  }, [accessibleRefunds, endDate, filteredContracts, managerFilter, startDate]);

  const filteredDeals = useMemo(() => {
    return deals.filter((deal) => isWithinDateRange(getDealDate(deal), startDate, endDate));
  }, [deals, endDate, startDate]);

  const totalSales = filteredContracts.reduce((sum, contract) => sum + getContractSalesAmount(contract), 0);
  const totalRefundsFromContracts = filteredContracts
    .filter(isRefundContract)
    .reduce((sum, contract) => sum + Math.abs(toAmount(contract.cost)), 0);
  const totalRefundsFromRefundRows = filteredRefunds.reduce((sum, refund) => sum + getRefundAmount(refund), 0);
  const totalRefunds = Math.max(totalRefundsFromContracts, totalRefundsFromRefundRows);
  const totalWorkCost = filteredContracts.reduce((sum, contract) => sum + getContractWorkCost(contract), 0);
  const netProfit = totalSales - totalRefunds - totalWorkCost;
  const slotOrderDays = filteredContracts.reduce((sum, contract) => sum + getContractSlotDays(contract, productByName), 0);
  const viralSalesCount = filteredContracts.filter((contract) =>
    !isRefundContract(contract) && getContractProductNames(contract).some(isViralProduct)
  ).length;
  const monthlyGuaranteeCount = filteredContracts.filter((contract) =>
    !isRefundContract(contract) && getContractProductNames(contract).some((name) => isMonthlyGuaranteeProduct(name, productByName))
  ).length;
  const otherContractCount = filteredContracts.filter((contract) => {
    if (isRefundContract(contract)) return false;
    const names = getContractProductNames(contract);
    return names.length === 0 || !names.some((name) =>
      isSlotProductByCategory(name, productByName) ||
      isMonthlyGuaranteeProduct(name, productByName) ||
      isViralProduct(name)
    );
  }).length;

  const monthlyRows = useMemo(() => {
    return Array.from({ length: 12 }, (_, index) => {
      const month = String(index + 1).padStart(2, "0");
      const monthKey = `${chartYear}-${month}`;
      const monthContracts = accessibleContracts.filter((contract) => {
        if (toMonthKey(getContractDate(contract)) !== monthKey) return false;
        const manager = String(contract.managerName || contract.manager || "").trim();
        return managerFilter === "all" || manager === managerFilter;
      });
      const monthContractIds = new Set(monthContracts.map((contract) => contract.id));
      const monthRefundRows = accessibleRefunds.filter((refund) => {
        if (toMonthKey(refund.refundDate || refund.createdAt) !== monthKey) return false;
        if (managerFilter === "all") return true;
        if (String(refund.managerName || "").trim() === managerFilter) return true;
        return !!refund.contractId && monthContractIds.has(refund.contractId);
      });
      const sales = monthContracts.reduce((sum, contract) => sum + getContractSalesAmount(contract), 0);
      const refundsByContract = monthContracts
        .filter(isRefundContract)
        .reduce((sum, contract) => sum + Math.abs(toAmount(contract.cost)), 0);
      const refundsByRows = monthRefundRows.reduce((sum, refund) => sum + getRefundAmount(refund), 0);
      const workCost = monthContracts.reduce((sum, contract) => sum + getContractWorkCost(contract), 0);
      return {
        month: `${index + 1}월`,
        sales,
        refunds: Math.max(refundsByContract, refundsByRows),
        workCost,
      };
    });
  }, [accessibleContracts, accessibleRefunds, chartYear, managerFilter]);

  const managerRows = useMemo(() => {
    const rows = new Map<string, { manager: string; sales: number; count: number; workCost: number }>();
    for (const contract of filteredContracts) {
      if (isRefundContract(contract)) continue;
      const manager = String(contract.managerName || contract.manager || "미지정").trim() || "미지정";
      const current = rows.get(manager) || { manager, sales: 0, count: 0, workCost: 0 };
      current.sales += getContractSalesAmount(contract);
      current.workCost += getContractWorkCost(contract);
      current.count += 1;
      rows.set(manager, current);
    }
    return Array.from(rows.values()).sort((left, right) => right.sales - left.sales).slice(0, 10);
  }, [filteredContracts]);

  const productRows = useMemo(() => {
    const rows = new Map<string, { product: string; sales: number; count: number }>();
    for (const contract of filteredContracts) {
      if (isRefundContract(contract)) continue;
      const names = getContractProductNames(contract);
      const product = names[0] || "기타";
      const current = rows.get(product) || { product, sales: 0, count: 0 };
      current.sales += getContractSalesAmount(contract);
      current.count += 1;
      rows.set(product, current);
    }
    return Array.from(rows.values()).sort((left, right) => right.sales - left.sales).slice(0, 10);
  }, [filteredContracts]);

  const recentMonths = useMemo(() => {
    const target = toKoreanDate(endDate) || new Date();
    return Array.from({ length: 3 }, (_, index) => {
      const date = new Date(target.getFullYear(), target.getMonth() - (2 - index), 1);
      const monthKey = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
      const monthContracts = accessibleContracts.filter((contract) => {
        if (toMonthKey(getContractDate(contract)) !== monthKey) return false;
        const manager = String(contract.managerName || contract.manager || "").trim();
        return managerFilter === "all" || manager === managerFilter;
      });
      const monthContractIds = new Set(monthContracts.map((contract) => contract.id));
      const monthRefundRows = accessibleRefunds.filter((refund) => {
        if (toMonthKey(refund.refundDate || refund.createdAt) !== monthKey) return false;
        if (managerFilter === "all") return true;
        if (String(refund.managerName || "").trim() === managerFilter) return true;
        return !!refund.contractId && monthContractIds.has(refund.contractId);
      });
      const sales = monthContracts.reduce((sum, contract) => sum + getContractSalesAmount(contract), 0);
      const refundsByContract = monthContracts
        .filter(isRefundContract)
        .reduce((sum, contract) => sum + Math.abs(toAmount(contract.cost)), 0);
      const refundsByRows = monthRefundRows.reduce((sum, refund) => sum + getRefundAmount(refund), 0);
      const workCost = monthContracts.reduce((sum, contract) => sum + getContractWorkCost(contract), 0);
      return {
        month: `${date.getMonth() + 1}월`,
        sales,
        refunds: Math.max(refundsByContract, refundsByRows),
        workCost,
        netProfit: sales - Math.max(refundsByContract, refundsByRows) - workCost,
      };
    });
  }, [accessibleContracts, accessibleRefunds, endDate, managerFilter]);

  const yearOptions = Array.from({ length: 4 }, (_, index) => String(Number(todayKey.slice(0, 4)) - index));
  const metricCards: MetricCard[] = [
    { label: "총 매출 금액", value: formatCurrency(totalSales), description: "부가세 제외 공급가 기준", accent: "text-blue-600", icon: CircleDollarSign },
    { label: "총 환불 금액", value: formatCurrency(totalRefunds), description: "환불 계약 및 환불 내역 기준", accent: "text-red-500", icon: TrendingDown },
    { label: "총 작업 비용", value: formatCurrency(totalWorkCost), description: "계약별 실행/작업비 합계", accent: "text-amber-600", icon: Target },
    { label: "순 수익 금액", value: formatCurrency(netProfit), description: "총 매출 - 환불 - 작업비", accent: "text-emerald-600", icon: TrendingUp },
    { label: "슬롯 발주 일수", value: formatCount(slotOrderDays, "일"), description: "슬롯 상품 일수 x 수량", accent: "text-sky-600", icon: CalendarDays },
    { label: "월보장 계약 수", value: formatCount(monthlyGuaranteeCount), description: "월보장 상품 계약 수", accent: "text-violet-600", icon: Target },
    { label: "바이럴 판매 건수", value: formatCount(viralSalesCount), description: "바이럴 상품 계약 수", accent: "text-fuchsia-600", icon: Sparkles },
    { label: "기타 계약 건수", value: formatCount(otherContractCount), description: "슬롯/월보장/바이럴 외 계약", accent: "text-zinc-700", icon: Box },
  ];

  const refreshAll = () => {
    refetchContracts();
    refetchDeals();
    refetchRefunds();
    refetchProducts();
  };

  const resetFilters = () => {
    setStartDate(`${todayKey.slice(0, 4)}-01-01`);
    setEndDate(todayKey);
    setPeriodFilter("thisYear");
    setSearchTerm("");
    setManagerFilter("all");
    setChartYear(todayKey.slice(0, 4));
  };

  return (
    <div className="min-h-full bg-background p-4 md:p-6 space-y-6">
      <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex items-center gap-3">
          <BarChart3 className="h-5 w-5 text-primary" />
          <div>
            <h1 className="text-xl md:text-2xl font-bold">매출분석</h1>
            <p className="text-sm text-muted-foreground">전체 데이터</p>
          </div>
        </div>
        <Button variant="outline" onClick={refreshAll} className="w-full sm:w-auto">
          <RefreshCw className="mr-2 h-4 w-4" />
          새로고침
        </Button>
      </div>

      <Card className="rounded-none shadow-none">
        <CardContent className="p-4">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="flex flex-col gap-3 md:flex-row md:items-center">
              <div className="flex items-center gap-2 text-sm font-medium text-muted-foreground">
                <Search className="h-4 w-4" />
                통합 필터
              </div>
              <DatePeriodFilter
                startDate={toKoreanDate(startDate) || new Date()}
                endDate={toKoreanDate(endDate) || new Date()}
                onStartDateChange={(date) => {
                  setStartDate(toDateKey(date));
                  setPeriodFilter("custom");
                }}
                onEndDateChange={(date) => {
                  setEndDate(toDateKey(date));
                  setPeriodFilter("custom");
                }}
                onReset={resetFilters}
                buttonClassName="w-full justify-start gap-2 rounded-none sm:w-56"
                buttonTestId="button-date-filter"
              />
              <Select value={managerFilter} onValueChange={setManagerFilter}>
                <SelectTrigger className="w-full rounded-none sm:w-44" data-testid="filter-sales-manager">
                  <SelectValue placeholder="담당자 전체" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">담당자 전체</SelectItem>
                  {managerOptions.map((manager) => (
                    <SelectItem key={manager} value={manager}>
                      {manager}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <Input
                value={searchTerm}
                onChange={(event) => setSearchTerm(event.target.value)}
                placeholder="고객, 상품, 담당자 검색"
                className="sm:w-64"
              />
            </div>
            <Button variant="ghost" onClick={resetFilters} className="justify-start xl:justify-center">
              <RotateCcw className="mr-2 h-4 w-4" />
              초기화
            </Button>
          </div>
        </CardContent>
      </Card>

      <section className="space-y-3">
        <div>
          <h2 className="text-base font-semibold">성과 요약</h2>
          <p className="text-sm text-muted-foreground">모든 금액은 부가세 제외 기준입니다.</p>
        </div>
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
          {metricCards.map((metric) => {
            const Icon = metric.icon;
            return (
              <Card key={metric.label} className="rounded-none shadow-sm">
                <CardContent className="p-4">
                  <div className="flex items-center gap-2 text-sm text-muted-foreground">
                    <Icon className="h-4 w-4" />
                    {metric.label}
                  </div>
                  <div className={`mt-2 text-2xl font-bold ${metric.accent}`}>{metric.value}</div>
                  <p className="mt-1 text-xs text-muted-foreground">{metric.description}</p>
                </CardContent>
              </Card>
            );
          })}
        </div>
      </section>

      <section className="space-y-3">
        <h2 className="border-l-4 border-primary pl-2 text-lg font-semibold">매출 추이</h2>
        <Card className="rounded-none shadow-none">
          <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <CardTitle className="text-base">년별 매출 추이</CardTitle>
            <Select value={chartYear} onValueChange={setChartYear}>
              <SelectTrigger className="w-full sm:w-28">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {yearOptions.map((option) => (
                  <SelectItem key={option} value={option}>{option}년</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </CardHeader>
          <CardContent>
            <div className="h-80">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={monthlyRows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis dataKey="month" fontSize={12} />
                  <YAxis fontSize={12} tickFormatter={formatAmount} />
                  <Tooltip formatter={(value: number) => formatCurrency(value)} />
                  <Legend />
                  <Bar dataKey="sales" name="매출" fill="#2563eb" />
                  <Bar dataKey="workCost" name="작업비" fill="#f97316" />
                  <Bar dataKey="refunds" name="환불" fill="#ef4444" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </CardContent>
        </Card>
      </section>

      <div className="grid gap-4 xl:grid-cols-2">
        <Card className="rounded-none shadow-none">
          <CardHeader>
            <CardTitle className="text-base">담당자별 매출 현황</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>담당자</TableHead>
                    <TableHead className="text-right">매출</TableHead>
                    <TableHead className="text-right">작업비</TableHead>
                    <TableHead className="text-right">건수</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {managerRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-12 text-center text-sm text-muted-foreground">
                        데이터가 없습니다
                      </TableCell>
                    </TableRow>
                  ) : (
                    managerRows.map((row) => (
                      <TableRow key={row.manager}>
                        <TableCell className="font-medium">{row.manager}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.sales)}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.workCost)}</TableCell>
                        <TableCell className="text-right">{formatCount(row.count)}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>

        <Card className="rounded-none shadow-none">
          <CardHeader>
            <CardTitle className="text-base">상품별 매출 현황</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>상품</TableHead>
                    <TableHead className="text-right">매출</TableHead>
                    <TableHead className="text-right">건수</TableHead>
                    <TableHead className="text-right">비중</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {productRows.length === 0 ? (
                    <TableRow>
                      <TableCell colSpan={4} className="py-12 text-center text-sm text-muted-foreground">
                        데이터가 없습니다
                      </TableCell>
                    </TableRow>
                  ) : (
                    productRows.map((row) => (
                      <TableRow key={row.product}>
                        <TableCell className="font-medium">{row.product}</TableCell>
                        <TableCell className="text-right">{formatCurrency(row.sales)}</TableCell>
                        <TableCell className="text-right">{formatCount(row.count)}</TableCell>
                        <TableCell className="text-right">
                          {totalSales > 0 ? `${((row.sales / totalSales) * 100).toFixed(1)}%` : "0.0%"}
                        </TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </div>
          </CardContent>
        </Card>
      </div>

      <Card className="rounded-none shadow-none">
        <CardHeader>
          <CardTitle className="text-base text-center">월간 현황</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="text-center">기간</TableHead>
                  <TableHead className="text-right">총 매출</TableHead>
                  <TableHead className="text-right">총 환불</TableHead>
                  <TableHead className="text-right">작업비</TableHead>
                  <TableHead className="text-right">순 수익</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {recentMonths.map((row) => (
                  <TableRow key={row.month}>
                    <TableCell className="text-center font-medium">{row.month}</TableCell>
                    <TableCell className="text-right">{formatCurrency(row.sales)}</TableCell>
                    <TableCell className="text-right text-red-500">{formatCurrency(row.refunds)}</TableCell>
                    <TableCell className="text-right text-amber-600">{formatCurrency(row.workCost)}</TableCell>
                    <TableCell className="text-right font-semibold">{formatCurrency(row.netProfit)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>

      <div className="sr-only" aria-live="polite">
        선택 범위 계약 {filteredContracts.length}건, 영업 데이터 {filteredDeals.length}건
      </div>
    </div>
  );
}
