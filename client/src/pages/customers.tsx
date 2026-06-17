import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useLocation } from "wouter";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { z } from "zod";
import { Users, Search, ArrowUpDown, Trash2, Download, Upload, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCeilAmount } from "@/lib/utils";
import { matchesKoreanSearch } from "@shared/korean-search";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";
import { Pagination } from "@/components/pagination";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { useAuth } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import { getKoreanDateKey, getKoreanNow } from "@/lib/korean-time";
import { insertCustomerSchema } from "@shared/schema";
import type {
  Customer,
  ContractWithFinancials,
  Deposit,
  User,
} from "@shared/schema";

type SortField =
  | "name"
  | "phone"
  | "email"
  | "customerType"
  | "customerCategory"
  | "serviceType"
  | "createdAt";
type SortDirection = "asc" | "desc";
type DetailTab = "basic" | "contracts" | "counseling" | "history" | "files";
type CustomerPageMode = "lead" | "company";

type CustomerCounseling = {
  id: string;
  customerId: string;
  counselingDate: string;
  content: string;
  createdBy: string | null;
  createdAt: string;
};

type CustomerChangeHistory = {
  id: string;
  customerId: string;
  changeType: string;
  changedFields: string | null;
  beforeData: string | null;
  afterData: string | null;
  createdBy: string | null;
  createdAt: string;
};

type CustomerFile = {
  id: string;
  customerId: string;
  fileName: string;
  mimeType: string | null;
  sizeBytes: number;
  uploadedBy: string | null;
  note: string | null;
  createdAt: string;
};

type CustomerListRow = Customer & {
  lastCounselingDate?: string | null;
  lastCounselingContent?: string | null;
  lastCounselingCreatedAt?: string | null;
  counselingCount?: number | null;
  companyConvertedAt?: string | null;
};

type CustomerListSummary = {
  contractCount: number;
  totalContractAmount: number;
  totalRefundAmount: number;
};

const customerFormSchema = insertCustomerSchema.extend({
  name: z.string().trim().min(1, "고객명을 입력하세요"),
  email: z.string().optional().or(z.literal("")),
  phone: z.string().optional().or(z.literal("")),
  company: z.string().optional().or(z.literal("")),
  status: z.string().default("active"),
  customerType: z.string().optional().or(z.literal("")),
  customerCategory: z.string().optional().or(z.literal("")),
  serviceType: z.string().optional().or(z.literal("")),
  managerName: z.string().optional().or(z.literal("")),
  notes: z.string().optional().or(z.literal("")),
});

const counselingFormSchema = z.object({
  counselingDate: z.string().min(1, "일자를 입력하세요"),
  content: z.string().trim().min(1, "상담 내용을 입력하세요"),
});

type CustomerFormData = z.infer<typeof customerFormSchema>;
type CounselingFormData = z.infer<typeof counselingFormSchema>;

const CUSTOMER_FIELD_LABELS: Record<string, string> = {
  name: "고객사 (회사명)",
  email: "이메일",
  phone: "전화번호",
  company: "담당자",
  status: "상태",
  customerType: "고객구분",
  customerCategory: "고객유형",
  serviceType: "서비스유형",
  managerName: "담당자",
  lifecycleStage: "고객상태",
  notes: "메모",
};

const SELECT_NONE_VALUE = "__NONE__";
const ADMIN_ROLES = ["대표이사", "총괄이사", "개발자"];
const LEAD_TYPE_DEFAULT = "가망";
const LEAD_CATEGORY_DEFAULT = "일반고객";
const EMPTY_PHONE_PLACEHOLDER = "01000000000";

function normalizeLeadCategory(value?: string | null): string {
  const trimmed = (value ?? "").trim();
  if (!trimmed || trimmed === "리드") return LEAD_CATEGORY_DEFAULT;
  return trimmed;
}

function normalizeOptional(value?: string | null): string | null {
  const trimmed = (value ?? "").trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeDuplicateName(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, "").toLowerCase();
}

function normalizeDuplicatePhone(value: unknown): string {
  return String(value ?? "").replace(/\D/g, "");
}

function isEmptyPhonePlaceholder(value: unknown): boolean {
  return normalizeDuplicatePhone(value) === EMPTY_PHONE_PLACEHOLDER;
}

function findDuplicateCustomer(
  customers: Customer[],
  payload: { name?: unknown; phone?: unknown },
  excludeCustomerId?: string,
) {
  const nameKey = normalizeDuplicateName(payload.name);
  const phoneKey = normalizeDuplicatePhone(payload.phone);
  if (!nameKey && !phoneKey) return undefined;

  return customers.find((customer) => {
    if (excludeCustomerId && customer.id === excludeCustomerId) return false;
    const existingNameKey = normalizeDuplicateName(customer.name);
    const existingPhoneKey = normalizeDuplicatePhone(customer.phone);
    const samePhone =
      !!phoneKey &&
      !isEmptyPhonePlaceholder(phoneKey) &&
      !!existingPhoneKey &&
      !isEmptyPhonePlaceholder(existingPhoneKey) &&
      phoneKey === existingPhoneKey;
    const sameName = !!nameKey && !!existingNameKey && nameKey === existingNameKey;
    return samePhone || (!phoneKey && sameName) || (sameName && !!existingPhoneKey && existingPhoneKey === phoneKey);
  });
}

function toNumber(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function normalizePaymentDisplay(value: unknown): string {
  const raw = String(value ?? "").trim();
  const normalized = raw.replace(/\s+/g, "");
  const asciiKey = normalized.replace(/[_-]/g, "").toLowerCase();
  if (!normalized) return "";
  if (["입금예정", "입금전"].includes(normalized) || ["beforedeposit", "pendingdeposit", "beforepayment", "unpaid"].includes(asciiKey)) {
    return "입금예정";
  }
  if (
    ["입금완료", "입금확인", "하나", "하나은행", "국민", "국민은행", "농협", "농협은행", "카드결제", "크몽"].includes(normalized) ||
    ["deposit", "deposited", "confirmed", "banktransfer", "transfer", "hana", "hanabank", "kb", "kookmin", "nonghyup", "nh", "card", "cardpayment", "kmong"].includes(asciiKey)
  ) {
    return "입금완료";
  }
  return raw;
}

function getDepositConfirmedAmount(deposit: Deposit | null | undefined): number {
  if (!deposit) return 0;
  const confirmedAmount = Math.max(0, Math.round(Number(deposit.confirmedAmount) || 0));
  if (confirmedAmount > 0) return confirmedAmount;
  return Math.max(0, Math.round(Number(deposit.depositAmount) || 0));
}

function normalizeCompactText(value: unknown): string {
  return String(value ?? "").trim().replace(/\s+/g, "");
}

function isCorruptedKeepUsagePaymentMethod(value: unknown): boolean {
  const normalized = normalizeCompactText(value);
  return normalized.length > 0 && /^\?+$/.test(normalized);
}

function isKeepUsageEntry(
  keepStatus: unknown,
  paymentMethod: unknown,
): boolean {
  const normalizedStatus = normalizeCompactText(keepStatus);
  if (normalizedStatus === "적립금사용" || normalizedStatus === "사용" || normalizedStatus === "차감") {
    return true;
  }

  const normalizedPaymentMethod = normalizeCompactText(paymentMethod);
  if (normalizedPaymentMethod === "적립금사용") {
    return true;
  }

  return isCorruptedKeepUsagePaymentMethod(paymentMethod);
}

function getKeepLedgerLabel(
  keepStatus: unknown,
  paymentMethod: unknown,
): string {
  if (isKeepUsageEntry(keepStatus, paymentMethod)) {
    return "적립금 사용";
  }

  const normalizedStatus = normalizeCompactText(keepStatus);
  if (normalizedStatus === "환불검토") {
    return "적립";
  }
  if (normalizedStatus === "적립금재사용") {
    return "적립";
  }

  return "적립";
}

function isResolvedKeepUsageEntry(
  keepStatus: unknown,
  paymentMethod: unknown,
): boolean {
  const normalizedStatus = normalizeCompactText(keepStatus);
  if (
    normalizedStatus === "\uC801\uB9BD\uAE08\uC0AC\uC6A9" ||
    normalizedStatus === "\uC0AC\uC6A9" ||
    normalizedStatus === "\uCC28\uAC10" ||
    normalizedStatus === "?곷┰湲덉궗??" ||
    normalizedStatus === "?ъ슜" ||
    normalizedStatus === "李④컧"
  ) {
    return true;
  }

  const normalizedPaymentMethod = normalizeCompactText(paymentMethod);
  if (
    normalizedPaymentMethod === "\uC801\uB9BD\uAE08\uC0AC\uC6A9" ||
    normalizedPaymentMethod === "?곷┰湲덉궗??"
  ) {
    return true;
  }

  return isCorruptedKeepUsagePaymentMethod(paymentMethod);
}

function getResolvedKeepLedgerLabel(
  keepStatus: unknown,
  paymentMethod: unknown,
): string {
  if (isResolvedKeepUsageEntry(keepStatus, paymentMethod)) {
    return "\uC801\uB9BD\uAE08 \uC0AC\uC6A9";
  }

  const normalizedStatus = normalizeCompactText(keepStatus);
  if (
    normalizedStatus === "\uD658\uBD88\uAC80\uD1A0" ||
    normalizedStatus === "\uC801\uB9BD\uAE08\uC7AC\uC0AC\uC6A9" ||
    normalizedStatus === "?섎텋寃??" ||
    normalizedStatus === "?곷┰湲덉옱?ъ슜"
  ) {
    return "\uC801\uB9BD";
  }

  return "\uC801\uB9BD";
}

function formatCurrency(value: number): string {
  return `${formatCeilAmount(value)}원`;
}

function formatFileSize(bytes: number): string {
  const size = toNumber(bytes);
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function truncatePreviewText(value: string, maxLength = 60): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
}

function parseObjectText(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object") return value as Record<string, unknown>;
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value);
      if (parsed && typeof parsed === "object") {
        return parsed as Record<string, unknown>;
      }
    } catch {
      return {};
    }
  }
  return {};
}

function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "-";
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : "-";
  }
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

function fieldLabel(fieldKey: string): string {
  return CUSTOMER_FIELD_LABELS[fieldKey] ?? fieldKey;
}

function parseApiErrorText(raw: string): string {
  try {
    const parsed = JSON.parse(raw);
    if (typeof parsed?.error === "string") {
      return parsed.error;
    }
  } catch {
    return raw || "요청 처리 중 오류가 발생했습니다.";
  }
  return raw || "요청 처리 중 오류가 발생했습니다.";
}

function extractErrorMessage(error: unknown, fallback: string): string {
  if (error instanceof Error && error.message) {
    const message = error.message;
    const colonIndex = message.indexOf(": ");
    if (colonIndex >= 0) {
      return parseApiErrorText(message.slice(colonIndex + 2));
    }
    return parseApiErrorText(message);
  }
  return fallback;
}

async function responseErrorMessage(response: Response, fallback: string): Promise<string> {
  try {
    const text = await response.text();
    return parseApiErrorText(text) || fallback;
  } catch {
    return fallback;
  }
}

function isCustomerMatch(customer: Customer, contract: ContractWithFinancials): boolean {
  if (contract.customerId && String(contract.customerId) === String(customer.id)) {
    return true;
  }
  if (!contract.customerId && customer.name && contract.customerName) {
    return customer.name.trim() === contract.customerName.trim();
  }
  return false;
}

function emptyTabGuide(title: string, noun = "고객") {
  return (
    <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
      {title} 탭은 {noun}을 먼저 저장한 뒤 사용할 수 있습니다.
    </div>
  );
}

function isLeadCustomer(customer: Customer) {
  return customer.lifecycleStage === "lead";
}

function getKoreanTodayKey(): string {
  return getKoreanDateKey(getKoreanNow());
}

export default function CustomersPage({ mode = "lead" }: { mode?: CustomerPageMode }) {
  const { toast } = useToast();
  const { formatDate, formatDateTime } = useSettings();
  const { user: currentUser } = useAuth();
  const [, setLocation] = useLocation();
  const [search, setSearch] = useState("");
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingCustomer, setEditingCustomer] = useState<Customer | undefined>();
  const [pageSize, setPageSize] = useState(10);
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [sortField, setSortField] = useState<SortField>("createdAt");
  const [sortDirection, setSortDirection] = useState<SortDirection>("desc");

  const { data: customers = [], isLoading } = useQuery<CustomerListRow[]>({
    queryKey: ["/api/customers"],
  });
  const isLeadMode = mode === "lead";
  const isAdminUser = ADMIN_ROLES.includes(currentUser?.role || "");
  const isCounselorUser = String(currentUser?.role || "").trim() === "상담원";
  const noun = isLeadMode ? "리드" : "고객사";
  const managementTitle = isLeadMode ? "리드관리" : "고객사관리";
  const canDeleteRows = isLeadMode || isAdminUser;
  const scopedCustomers = useMemo(() => {
    return customers.filter((customer) => (isLeadMode ? isLeadCustomer(customer) : !isLeadCustomer(customer)));
  }, [customers, isLeadMode]);

  const { data: customerListContracts = [] } = useQuery<ContractWithFinancials[]>({
    queryKey: ["/api/contracts-with-financials"],
  });

  const customerListSummaryById = useMemo(() => {
    const map = new Map<string, CustomerListSummary>();
    scopedCustomers.forEach((customer) => {
      map.set(customer.id, { contractCount: 0, totalContractAmount: 0, totalRefundAmount: 0 });
    });

    for (const contract of customerListContracts) {
      const customer = scopedCustomers.find((item) => isCustomerMatch(item, contract));
      if (!customer) continue;
      const current = map.get(customer.id) || { contractCount: 0, totalContractAmount: 0, totalRefundAmount: 0 };
      const isRefund = String((contract as { contractType?: string | null }).contractType || "").toLowerCase() === "refund" || toNumber(contract.cost) < 0;
      if (isRefund) {
        current.totalRefundAmount += Math.abs(toNumber(contract.cost));
      } else {
        current.contractCount += 1;
        current.totalContractAmount += Math.max(0, toNumber(contract.cost));
        current.totalRefundAmount += Math.max(0, toNumber(contract.totalRefund));
      }
      map.set(customer.id, current);
    }

    return map;
  }, [customerListContracts, scopedCustomers]);

  const filteredCustomers = useMemo(() => {
    const keyword = search.trim();
    if (!keyword) return scopedCustomers;
    return scopedCustomers.filter((customer) => {
      return matchesKoreanSearch(
        [
          customer.name,
          customer.phone,
          customer.email,
          customer.customerType,
          customer.customerCategory,
          customer.serviceType,
          customer.notes,
          customer.lastCounselingContent,
        ],
        keyword,
      );
    });
  }, [scopedCustomers, search]);

  const sortedCustomers = useMemo(() => {
    const sorted = [...filteredCustomers];
    sorted.sort((a, b) => {
      if (sortField === "createdAt") {
        const aTime = new Date(a.createdAt).getTime();
        const bTime = new Date(b.createdAt).getTime();
        return sortDirection === "asc" ? aTime - bTime : bTime - aTime;
      }

      const aValue = String(a[sortField] ?? "").toLowerCase();
      const bValue = String(b[sortField] ?? "").toLowerCase();
      if (aValue < bValue) return sortDirection === "asc" ? -1 : 1;
      if (aValue > bValue) return sortDirection === "asc" ? 1 : -1;
      return 0;
    });
    return sorted;
  }, [filteredCustomers, sortField, sortDirection]);

  const totalPages = Math.max(1, Math.ceil(sortedCustomers.length / pageSize));
  const paginatedCustomers = sortedCustomers.slice(
    (currentPage - 1) * pageSize,
    currentPage * pageSize,
  );

  useEffect(() => {
    if (currentPage > totalPages) {
      setCurrentPage(totalPages);
    }
  }, [currentPage, totalPages]);

  const bulkDeleteMutation = useMutation({
    mutationFn: async (ids: string[]) => {
      const results = await Promise.allSettled(
        ids.map((id) => apiRequest("DELETE", `/api/customers/${id}`)),
      );

      const failedCount = results.filter((result) => result.status === "rejected").length;
      if (failedCount === ids.length) {
        throw new Error(`선택한 ${noun}을 삭제하지 못했습니다.`);
      }
      if (failedCount > 0) {
        throw new Error(`${ids.length - failedCount}건 삭제 완료, ${failedCount}건 실패`);
      }
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setSelectedIds(new Set());
      toast({ title: `선택한 ${noun}이 삭제되었습니다.` });
    },
    onError: (error) => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setSelectedIds(new Set());
      toast({
        title: extractErrorMessage(error, `${noun} 삭제 중 오류가 발생했습니다.`),
        variant: "destructive",
      });
    },
  });

  const convertToCompanyMutation = useMutation({
    mutationFn: async (customerId: string) => {
      await apiRequest("POST", `/api/customers/${customerId}/convert-to-company`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      setSelectedIds(new Set());
      toast({ title: "고객사로 전환되었습니다." });
      setLocation("/customer-companies");
    },
    onError: (error) => {
      toast({
        title: extractErrorMessage(error, "고객사 전환 중 오류가 발생했습니다."),
        variant: "destructive",
      });
    },
  });

  const openCreateDialog = () => {
    setEditingCustomer(undefined);
    setIsDialogOpen(true);
  };

  const openEditDialog = (customer: Customer) => {
    setEditingCustomer(customer);
    setIsDialogOpen(true);
  };

  const closeDialog = () => {
    setIsDialogOpen(false);
    setEditingCustomer(undefined);
  };

  const handleSort = (field: SortField) => {
    if (sortField === field) {
      setSortDirection((prev) => (prev === "asc" ? "desc" : "asc"));
      return;
    }
    setSortField(field);
    setSortDirection("asc");
  };

  const handleSelectAll = (checked: boolean) => {
    if (!canDeleteRows) return;
    if (checked) {
      setSelectedIds(new Set(paginatedCustomers.map((customer) => customer.id)));
      return;
    }
    setSelectedIds(new Set());
  };

  const handleSelectOne = (customerId: string, checked: boolean) => {
    if (!canDeleteRows) return;
    const next = new Set(selectedIds);
    if (checked) {
      next.add(customerId);
    } else {
      next.delete(customerId);
    }
    setSelectedIds(next);
  };

  const handleBulkDelete = () => {
    if (selectedIds.size === 0) return;
    if (!canDeleteRows) return;
    if (!window.confirm(`선택한 ${noun} ${selectedIds.size}건을 삭제하시겠습니까?`)) return;
    bulkDeleteMutation.mutate(Array.from(selectedIds));
  };

  const handleConvertToCompany = (customer: Customer) => {
    if (isCounselorUser) {
      toast({ title: "상담원은 고객사 전환을 수행할 수 없습니다.", variant: "destructive" });
      return;
    }
    if (!window.confirm(`${customer.name} 리드를 고객사로 전환하시겠습니까? 전환 후 리드로 되돌릴 수 없습니다.`)) return;
    convertToCompanyMutation.mutate(customer.id);
  };

  useEffect(() => {
    setSelectedIds(new Set());
    setCurrentPage(1);
  }, [mode]);

  const allSelected =
    paginatedCustomers.length > 0 &&
    paginatedCustomers.every((customer) => selectedIds.has(customer.id));

  const SortableHeader = ({
    field,
    children,
  }: {
    field: SortField;
    children: ReactNode;
  }) => (
    <TableHead
      className="cursor-pointer select-none whitespace-nowrap text-xs"
      onClick={() => handleSort(field)}
      data-testid={`sort-${field}`}
    >
      <div className="flex items-center gap-1">
        {children}
        <ArrowUpDown className="h-3 w-3 text-muted-foreground" />
      </div>
    </TableHead>
  );

  if (isLoading) {
    return (
      <div className="space-y-4 p-6">
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-[420px] w-full" />
      </div>
    );
  }

  return (
    <div className="space-y-4 p-4 sm:p-6">
      <div className="sticky top-0 z-30 -mx-4 -mt-4 space-y-3 border-b border-border/80 bg-background/95 px-4 pb-4 pt-4 backdrop-blur supports-[backdrop-filter]:bg-background/75 sm:-mx-6 sm:-mt-6 sm:px-6 sm:pt-6">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div className="flex min-w-0 items-center gap-2 sm:gap-3">
          <Users className="h-5 w-5 shrink-0 text-primary sm:h-6 sm:w-6" />
          <h1 className="truncate text-lg font-bold leading-tight sm:text-xl" data-testid="text-customers-title">
            {managementTitle}
          </h1>
        </div>

        <div className="grid w-full grid-cols-[1fr_auto_auto] items-center gap-2 lg:flex lg:w-auto lg:gap-3">
          <span className="col-span-3 text-sm text-muted-foreground lg:col-auto" data-testid="text-search-count">
            검색 결과 {filteredCustomers.length}건
          </span>

          <div className="relative min-w-0">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              value={search}
              onChange={(event) => {
                setSearch(event.target.value);
                setCurrentPage(1);
              }}
              placeholder={`${noun}명/전화번호/유형 검색`}
              className="h-10 w-full rounded-none pl-9 pr-9 text-sm lg:w-64"
              data-testid="input-search-customers"
            />
          </div>

          <Button
            variant="outline"
            className="h-10 rounded-none px-3"
            onClick={handleBulkDelete}
            disabled={!canDeleteRows || selectedIds.size === 0 || bulkDeleteMutation.isPending}
            data-testid="button-bulk-delete"
          >
            <Trash2 className="h-4 w-4 lg:mr-1" />
            <span className="hidden lg:inline">삭제</span>
          </Button>

          {isLeadMode ? (
            <Button
              className="h-10 rounded-none bg-primary px-4 hover:bg-primary/90"
              onClick={openCreateDialog}
              data-testid="button-add-customer"
            >
              리드 등록
            </Button>
          ) : null}
        </div>
      </div>
      </div>

      <div className="overflow-x-auto border border-border bg-background">
        <Table className="w-full min-w-[1280px]">
          <TableHeader>
            <TableRow className="bg-muted/30">
              <TableHead className="w-[40px]">
                <Checkbox
                  checked={allSelected}
                  onCheckedChange={(checked) => handleSelectAll(checked === true)}
                  disabled={!canDeleteRows}
                  data-testid="checkbox-select-all"
                />
              </TableHead>
              <SortableHeader field="name">고객사 (회사명)</SortableHeader>
              <SortableHeader field="phone">전화번호</SortableHeader>
              <SortableHeader field="customerType">고객구분</SortableHeader>
              <SortableHeader field="customerCategory">고객유형</SortableHeader>
              {!isLeadMode ? <TableHead className="whitespace-nowrap text-right text-xs">계약수</TableHead> : null}
              {!isLeadMode ? <TableHead className="whitespace-nowrap text-right text-xs">총 계약금액</TableHead> : null}
              {!isLeadMode ? <TableHead className="whitespace-nowrap text-right text-xs">총 환불 금액</TableHead> : null}
              {isLeadMode ? <TableHead className="whitespace-nowrap text-right text-xs">상담 건수</TableHead> : null}
              <TableHead className="text-xs">마지막 상담 이력</TableHead>
              <TableHead className="whitespace-nowrap text-xs">{isLeadMode ? "등록자" : "담당자"}</TableHead>
              <SortableHeader field="createdAt">{isLeadMode ? "등록시간" : "고객사 전환시간"}</SortableHeader>
              {isLeadMode ? <TableHead className="whitespace-nowrap text-right text-xs">관리</TableHead> : null}
            </TableRow>
          </TableHeader>
          <TableBody>
            {paginatedCustomers.length === 0 ? (
              <TableRow>
                <TableCell colSpan={isLeadMode ? 10 : 11} className="py-8 text-center text-muted-foreground">
                  {search ? "검색 결과가 없습니다." : `등록된 ${noun}이 없습니다.`}
                </TableCell>
              </TableRow>
            ) : (
              paginatedCustomers.map((customer) => (
                <TableRow key={customer.id} data-testid={`row-customer-${customer.id}`}>
                  <TableCell>
                    <Checkbox
                      checked={selectedIds.has(customer.id)}
                      onCheckedChange={(checked) => handleSelectOne(customer.id, checked === true)}
                      disabled={!canDeleteRows}
                      data-testid={`checkbox-customer-${customer.id}`}
                    />
                  </TableCell>
                  <TableCell className="text-xs font-medium">
                    <button
                      type="button"
                      className="text-left hover:text-primary"
                      onClick={() => openEditDialog(customer)}
                      data-testid={`button-edit-customer-${customer.id}`}
                    >
                      {customer.name}
                    </button>
                  </TableCell>
                  <TableCell className="text-xs">{customer.phone || "-"}</TableCell>
                  <TableCell className="text-xs">{customer.customerType || "-"}</TableCell>
                  <TableCell className="text-xs">
                    {isLeadMode ? normalizeLeadCategory(customer.customerCategory) : customer.customerCategory || "-"}
                  </TableCell>
                  {!isLeadMode ? <TableCell className="text-right text-xs">{(customerListSummaryById.get(customer.id)?.contractCount || 0).toLocaleString("ko-KR")}건</TableCell> : null}
                  {!isLeadMode ? <TableCell className="text-right text-xs">{formatCurrency(customerListSummaryById.get(customer.id)?.totalContractAmount || 0)}</TableCell> : null}
                  {!isLeadMode ? <TableCell className="text-right text-xs text-red-600">{formatCurrency(customerListSummaryById.get(customer.id)?.totalRefundAmount || 0)}</TableCell> : null}
                  {isLeadMode ? <TableCell className="text-right text-xs">{Number(customer.counselingCount || 0).toLocaleString("ko-KR")}건</TableCell> : null}
                  <TableCell className="max-w-[260px] text-xs">
                    {customer.lastCounselingContent ? (
                      <span className="block truncate" title={customer.lastCounselingContent}>
                        {customer.lastCounselingDate ? `${formatDate(customer.lastCounselingDate)} ` : ""}{truncatePreviewText(customer.lastCounselingContent, 40)}
                      </span>
                    ) : "-"}
                  </TableCell>
                  <TableCell className="text-xs whitespace-nowrap">{isLeadMode ? customer.createdByName || "-" : customer.managerName || "-"}</TableCell>
                  <TableCell className="text-xs whitespace-nowrap">
                    {formatDateTime(isLeadMode ? customer.createdAt : customer.companyConvertedAt || customer.createdAt)}
                  </TableCell>
                  {isLeadMode ? (
                    <TableCell className="text-right">
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        className="h-8 rounded-none whitespace-nowrap"
                        onClick={() => handleConvertToCompany(customer)}
                        disabled={isCounselorUser || convertToCompanyMutation.isPending}
                        title={isCounselorUser ? "상담원은 고객사 전환을 수행할 수 없습니다." : undefined}
                        data-testid={`button-convert-customer-${customer.id}`}
                      >
                        고객사 전환
                      </Button>
                    </TableCell>
                  ) : null}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <Select
          value={String(pageSize)}
          onValueChange={(value) => {
            setPageSize(Number(value));
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="h-9 w-auto min-w-[130px] rounded-none" data-testid="select-page-size">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="10">10개씩 보기</SelectItem>
            <SelectItem value="20">20개씩 보기</SelectItem>
            <SelectItem value="50">50개씩 보기</SelectItem>
          </SelectContent>
        </Select>

        <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
      </div>

      <CustomerDetailDialog
        open={isDialogOpen}
        customer={editingCustomer}
        customers={customers}
        mode={mode}
        onOpenChange={(nextOpen) => {
          if (!nextOpen) {
            closeDialog();
            return;
          }
          setIsDialogOpen(true);
        }}
        onSaved={closeDialog}
      />
    </div>
  );
}

function CustomerDetailDialog({
  open,
  customer,
  customers,
  mode,
  onOpenChange,
  onSaved,
}: {
  open: boolean;
  customer?: Customer;
  customers: Customer[];
  mode: CustomerPageMode;
  onOpenChange: (open: boolean) => void;
  onSaved: () => void;
}) {
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const { formatDate, formatDateTime } = useSettings();
  const [activeTab, setActiveTab] = useState<DetailTab>("basic");
  const [selectedFile, setSelectedFile] = useState<File | null>(null);
  const [fileNote, setFileNote] = useState("");

  const customerId = customer?.id ?? "";
  const isEditMode = Boolean(customerId);
  const isLeadMode = mode === "lead";
  const isAdminUser = ADMIN_ROLES.includes(currentUser?.role || "");
  const noun = isLeadMode ? "리드" : "고객사";
  const canEditName = isLeadMode || !isEditMode || isAdminUser;
  const visibleTabs: DetailTab[] = isLeadMode ? ["basic", "counseling", "history"] : ["basic", "contracts", "counseling", "history", "files"];

  const form = useForm<CustomerFormData>({
    resolver: zodResolver(customerFormSchema),
    defaultValues: {
      name: customer?.name || "",
      email: customer?.email || "",
      phone: customer?.phone || "",
      company: customer?.company || "",
      status: customer?.status || "active",
      customerType: isLeadMode ? customer?.customerType || LEAD_TYPE_DEFAULT : "계약완료",
      customerCategory: isLeadMode ? normalizeLeadCategory(customer?.customerCategory) : customer?.customerCategory || "",
      serviceType: customer?.serviceType || "",
      managerName: customer?.managerName || currentUser?.name || "",
      notes: customer?.notes || "",
    },
  });

  const counselingForm = useForm<CounselingFormData>({
    resolver: zodResolver(counselingFormSchema),
    defaultValues: {
      counselingDate: getKoreanTodayKey(),
      content: "",
    },
  });

  useEffect(() => {
    form.reset({
      name: customer?.name || "",
      email: customer?.email || "",
      phone: customer?.phone || "",
      company: customer?.company || "",
      status: customer?.status || "active",
      customerType: isLeadMode ? customer?.customerType || LEAD_TYPE_DEFAULT : "계약완료",
      customerCategory: isLeadMode ? normalizeLeadCategory(customer?.customerCategory) : customer?.customerCategory || "",
      serviceType: customer?.serviceType || "",
      managerName: customer?.managerName || currentUser?.name || "",
      notes: customer?.notes || "",
    });
    counselingForm.reset({
      counselingDate: getKoreanTodayKey(),
      content: "",
    });
    setSelectedFile(null);
    setFileNote("");
    setActiveTab("basic");
  }, [customerId, customer, currentUser?.name, form, counselingForm, isLeadMode]);

  useEffect(() => {
    if (!visibleTabs.includes(activeTab)) {
      setActiveTab("basic");
    }
  }, [activeTab, visibleTabs]);

  const { data: users = [] } = useQuery<User[]>({
    queryKey: ["/api/users"],
    enabled: open,
  });

  const managerOptions = useMemo(() => {
    const names = new Set<string>();
    users
      .filter((user) => user.isActive !== false)
      .forEach((user) => {
        if (user.name?.trim()) names.add(user.name.trim());
      });
    const currentManagerName = String(form.watch("managerName") || customer?.managerName || "").trim();
    if (currentManagerName) names.add(currentManagerName);
    if (currentUser?.name?.trim()) names.add(currentUser.name.trim());
    return Array.from(names).sort((a, b) => a.localeCompare(b, "ko-KR"));
  }, [customer?.managerName, currentUser?.name, form, users]);

  const { data: allContracts = [], isLoading: contractsLoading } = useQuery<ContractWithFinancials[]>({
    queryKey: ["/api/contracts-with-financials"],
    enabled: open && isEditMode,
  });

  const { data: allDeposits = [] } = useQuery<Deposit[]>({
    queryKey: ["/api/deposits"],
    enabled: open && isEditMode && !isLeadMode,
  });

  const { data: counselingHistory = [], isLoading: counselingLoading } = useQuery<CustomerCounseling[]>({
    queryKey: ["/api/customers", customerId, "counselings"],
    enabled: open && isEditMode,
  });

  const { data: changeHistory = [], isLoading: historyLoading } = useQuery<CustomerChangeHistory[]>({
    queryKey: ["/api/customers", customerId, "change-history"],
    enabled: open && isEditMode,
  });

  const companyConvertedAt = useMemo(() => {
    const converted = changeHistory
      .filter((row) => row.changeType === "convert_to_company")
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())[0];
    return converted?.createdAt || customer?.createdAt;
  }, [changeHistory, customer?.createdAt]);

  const { data: customerFiles = [], isLoading: filesLoading } = useQuery<CustomerFile[]>({
    queryKey: ["/api/customers", customerId, "files"],
    enabled: open && isEditMode,
  });

  const customerContracts = useMemo(() => {
    if (!customer) return [];
    return allContracts
      .filter((contract) => isCustomerMatch(customer, contract))
      .sort(
        (a, b) =>
          new Date(b.contractDate ?? b.createdAt).getTime() -
          new Date(a.contractDate ?? a.createdAt).getTime(),
      );
  }, [allContracts, customer]);

  const depositAmountByContractId = useMemo(() => {
    const next = new Map<string, number>();
    for (const deposit of allDeposits) {
      const contractId = String(deposit.contractId || "").trim();
      if (!contractId) continue;
      next.set(contractId, (next.get(contractId) || 0) + getDepositConfirmedAmount(deposit));
    }
    return next;
  }, [allDeposits]);

  /*
  const customerKeepHistory = useMemo(() => {
    if (!customerContractIds.size) return [];
    return allKeeps.filter(
      (keep) =>
        customerContractIds.has(String(keep.contractId)) &&
        (keep.keepStatus || "적립금 재사용") === "적립금 재사용",
    );
  }, [allKeeps, customerContractIds]);

  const customerKeepLedgerHistory = useMemo(() => {
    if (!customerContractIds.size) return [];
    return allKeeps
      .filter((keep) => customerContractIds.has(String(keep.contractId)))
      .sort(
        (a, b) =>
          new Date(b.keepDate ?? b.createdAt ?? 0).getTime() -
          new Date(a.keepDate ?? a.createdAt ?? 0).getTime(),
      );
  }, [allKeeps, customerContractIds]);
  void customerKeepHistory;

  const customerKeepLedgerHasAmountByContractId = useMemo(() => {
    const next = new Set<string>();
    for (const keep of customerKeepLedgerHistory) {
      const contractId = String(keep.contractId);
      const contract = customerContractMap.get(contractId);
      const amount = getFinancialAmountWithVat(contract, keep);
      if (amount > 0) {
        next.add(contractId);
      }
    }
    return next;
  }, [customerKeepLedgerHistory, customerContractMap]);

  const customerKeepUsageFallbackByContractId = useMemo(() => {
    const next = new Map<string, number>();
    for (const contract of customerContracts) {
      const contractId = String(contract.id);
      const paymentMethod = customerContractPaymentMethodMap.get(contractId);
      if (paymentMethod !== "적립금 사용") continue;
      if (customerKeepLedgerHasAmountByContractId.has(contractId)) continue;
      const fallbackAmount = getFinancialTargetGrossAmount(contract, {
        targetAmount: Number(contract.cost) || 0,
      });
      if (fallbackAmount > 0) {
        next.set(contractId, fallbackAmount);
      }
    }
    return next;
  }, [customerContracts, customerContractPaymentMethodMap, customerKeepLedgerHasAmountByContractId]);

  const customerKeepLedgerAmountByContractId = useMemo(() => {
    const next = new Map<string, number>();
    for (const keep of customerKeepLedgerHistory) {
      const contractId = String(keep.contractId);
      const contract = customerContractMap.get(contractId);
      const paymentMethod = customerContractPaymentMethodMap.get(contractId);
      const amount = getFinancialAmountWithVat(contract, keep);
      const signedAmount = isResolvedKeepUsageEntry(keep.keepStatus, paymentMethod) ? -amount : amount;
      next.set(contractId, (next.get(contractId) || 0) + signedAmount);
    }
    customerKeepUsageFallbackByContractId.forEach((amount, contractId) => {
      next.set(contractId, (next.get(contractId) || 0) - amount);
    });
    return next;
  }, [customerKeepLedgerHistory, customerContractMap, customerContractPaymentMethodMap, customerKeepUsageFallbackByContractId]);

  */
  const summary = useMemo(() => {
    const contractCount = customerContracts.length;
    const contractAmount = customerContracts.reduce((sum, contract) => sum + toNumber(contract.cost), 0);
    const refundAmount = customerContracts.reduce((sum, contract) => sum + toNumber(contract.totalRefund), 0);
    const depositAmount = customerContracts.reduce((sum, contract) => {
      const linkedDepositAmount = depositAmountByContractId.get(String(contract.id)) || 0;
      if (linkedDepositAmount > 0) return sum + linkedDepositAmount;
      return normalizePaymentDisplay(contract.paymentMethod) === "입금완료" || contract.paymentConfirmed === true
        ? sum + Math.max(0, toNumber(contract.cost) - toNumber(contract.totalRefund))
        : sum;
    }, 0);
    const receivableAmount = Math.max(0, contractAmount - refundAmount - depositAmount);
    return { contractCount, contractAmount, refundAmount, depositAmount, receivableAmount };
  }, [customerContracts, depositAmountByContractId]);

  const saveCustomerMutation = useMutation({
    mutationFn: async (data: CustomerFormData) => {
      if (isLeadMode && !isEditMode && normalizeDuplicatePhone(data.phone).length === 0) {
        throw new Error("리드 등록 시 전화번호는 필수입니다. 번호가 없으면 010-0000-0000을 입력하세요.");
      }

      const payload = {
        name: data.name.trim(),
        email: normalizeOptional(data.email),
        phone: normalizeOptional(data.phone),
        company: normalizeOptional(data.company),
        status: normalizeOptional(data.status) || "active",
        customerType: isLeadMode ? normalizeOptional(data.customerType) || LEAD_TYPE_DEFAULT : "계약완료",
        customerCategory: isLeadMode
          ? normalizeLeadCategory(data.customerCategory)
          : normalizeOptional(data.customerCategory),
        serviceType: normalizeOptional(data.serviceType),
        managerName: normalizeOptional(data.managerName) || normalizeOptional(currentUser?.name),
        notes: normalizeOptional(data.notes),
        lifecycleStage: isLeadMode ? "lead" : "customer",
      };

      const duplicate = findDuplicateCustomer(customers, payload, isEditMode ? customerId : undefined);
      if (duplicate) {
        const duplicateType = duplicate.lifecycleStage === "lead" ? "리드" : "고객사";
        throw new Error(`이미 등록된 ${duplicateType}입니다. (${duplicate.name || "이름 없음"} / ${duplicate.phone || "전화번호 없음"})`);
      }

      if (isEditMode) {
        await apiRequest("PUT", `/api/customers/${customerId}`, payload);
        return "update";
      }
      await apiRequest("POST", "/api/customers", payload);
      return "create";
    },
    onSuccess: (result) => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      queryClient.invalidateQueries({ queryKey: ["/api/stats"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-analytics"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts/paged"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts-with-financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/payments"] });
      queryClient.invalidateQueries({ queryKey: ["/api/refunds"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-analytics"] });
      if (isEditMode) {
        queryClient.invalidateQueries({ queryKey: ["/api/customers", customerId, "change-history"] });
      }

      toast({
        title: result === "update" ? `${noun} 정보가 수정되었습니다.` : `${noun}이 등록되었습니다.`,
      });
      onSaved();
    },
    onError: (error) => {
      toast({
        title: extractErrorMessage(error, `${noun} 저장 중 오류가 발생했습니다.`),
        variant: "destructive",
      });
    },
  });

  const createCounselingMutation = useMutation({
    mutationFn: async (data: CounselingFormData) => {
      await apiRequest("POST", `/api/customers/${customerId}/counselings`, {
        counselingDate: data.counselingDate,
        content: data.content.trim(),
      });
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers", customerId, "counselings"] });
      queryClient.invalidateQueries({ queryKey: ["/api/customers"] });
      counselingForm.reset({
        counselingDate: getKoreanTodayKey(),
        content: "",
      });
      toast({ title: `${noun} 상담 내용이 등록되었습니다.` });
    },
    onError: (error) => {
      toast({
        title: extractErrorMessage(error, "상담 등록 중 오류가 발생했습니다."),
        variant: "destructive",
      });
    },
  });

  const deleteCounselingMutation = useMutation({
    mutationFn: async (counselingId: string) => {
      await apiRequest("DELETE", `/api/customers/${customerId}/counselings/${counselingId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers", customerId, "counselings"] });
      toast({ title: "상담 이력이 삭제되었습니다." });
    },
    onError: (error) => {
      toast({
        title: extractErrorMessage(error, "상담 이력 삭제 중 오류가 발생했습니다."),
        variant: "destructive",
      });
    },
  });

  const uploadFileMutation = useMutation({
    mutationFn: async (file: File) => {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("note", fileNote.trim());

      const response = await fetch(`/api/customers/${customerId}/files`, {
        method: "POST",
        body: formData,
        credentials: "include",
      });

      if (!response.ok) {
        throw new Error(await responseErrorMessage(response, "파일 업로드 중 오류가 발생했습니다."));
      }
      return response.json();
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers", customerId, "files"] });
      setSelectedFile(null);
      setFileNote("");
      toast({ title: "파일이 업로드되었습니다." });
    },
    onError: (error) => {
      toast({
        title: extractErrorMessage(error, "파일 업로드 중 오류가 발생했습니다."),
        variant: "destructive",
      });
    },
  });

  const deleteFileMutation = useMutation({
    mutationFn: async (fileId: string) => {
      await apiRequest("DELETE", `/api/customers/${customerId}/files/${fileId}`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/customers", customerId, "files"] });
      toast({ title: "파일이 삭제되었습니다." });
    },
    onError: (error) => {
      toast({
        title: extractErrorMessage(error, "파일 삭제 중 오류가 발생했습니다."),
        variant: "destructive",
      });
    },
  });

  const canUploadMore = customerFiles.length < 5;

  const handleSaveCustomer = (data: CustomerFormData) => {
    saveCustomerMutation.mutate(data);
  };

  const handleCreateCounseling = (data: CounselingFormData) => {
    if (!isEditMode) return;
    createCounselingMutation.mutate(data);
  };

  const handleDeleteCounseling = (counselingId: string) => {
    if (!isEditMode) return;
    if (!window.confirm("선택한 상담 이력을 삭제하시겠습니까?")) return;
    deleteCounselingMutation.mutate(counselingId);
  };

  const handleApplyCounselingContent = (row: CustomerCounseling) => {
    if (!isEditMode) return;
    counselingForm.setValue("content", row.content, {
      shouldDirty: true,
      shouldTouch: true,
      shouldValidate: true,
    });
    counselingForm.setFocus("content");
  };

  const handleUploadFile = () => {
    if (!isEditMode || !selectedFile) return;
    uploadFileMutation.mutate(selectedFile);
  };

  const handleDeleteFile = (fileId: string) => {
    if (!isEditMode) return;
    if (!window.confirm("선택한 파일을 삭제하시겠습니까?")) return;
    deleteFileMutation.mutate(fileId);
  };

  const handleDownloadFile = (fileId: string) => {
    if (!isEditMode) return;
    window.open(`/api/customers/${customerId}/files/${fileId}/download`, "_blank");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[92vh] overflow-y-auto rounded-none"
        style={{ width: "1200px", maxWidth: "97vw" }}
      >
        <DialogHeader>
          <DialogTitle>{isEditMode ? `${noun} 상세 정보` : `새 ${noun} 등록`}</DialogTitle>
          <DialogDescription>
            {isLeadMode
              ? "기본정보, 리드상담, 변경이력을 관리합니다."
              : "기본정보, 계약관리, 고객상담, 변경이력, 파일 정보를 한 화면에서 관리합니다."}
          </DialogDescription>
        </DialogHeader>

        <Tabs value={activeTab} onValueChange={(value) => setActiveTab(value as DetailTab)}>
          <TabsList className="w-full justify-start rounded-none">
            <TabsTrigger value="basic">기본정보</TabsTrigger>
            {!isLeadMode ? (
              <TabsTrigger value="contracts" disabled={!isEditMode}>
                계약관리
              </TabsTrigger>
            ) : null}
            <TabsTrigger value="counseling" disabled={!isEditMode}>
              {isLeadMode ? "리드상담" : "고객상담"}
            </TabsTrigger>
            <TabsTrigger value="history" disabled={!isEditMode}>
              변경이력
            </TabsTrigger>
            {!isLeadMode ? (
              <TabsTrigger value="files" disabled={!isEditMode}>
                파일
              </TabsTrigger>
            ) : null}
          </TabsList>

          <TabsContent value="basic" className="space-y-4">
            {isEditMode ? (
              <div className="grid gap-2 border border-border bg-muted/20 p-3 text-xs text-muted-foreground sm:grid-cols-2">
                <div>
                  <span className="font-medium text-foreground">{isLeadMode ? "등록자" : "담당자"}</span>
                  <span className="ml-2">{isLeadMode ? customer?.createdByName || "-" : customer?.managerName || "-"}</span>
                </div>
                <div>
                  <span className="font-medium text-foreground">{isLeadMode ? "등록시간" : "고객사 전환시간"}</span>
                  <span className="ml-2">{formatDateTime(isLeadMode ? customer?.createdAt : companyConvertedAt)}</span>
                </div>
              </div>
            ) : null}
            <Form {...form}>
              <form onSubmit={form.handleSubmit(handleSaveCustomer)} className="space-y-4">
                <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
                  <FormField
                    control={form.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>고객사 (회사명) *</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            placeholder="고객사 또는 회사명을 입력하세요"
                            className="rounded-none"
                            disabled={!canEditName}
                            data-testid="input-customer-name"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="managerName"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{isLeadMode ? "등록자" : "담당자"}</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === SELECT_NONE_VALUE ? "" : value)}
                          value={field.value && field.value.length > 0 ? field.value : SELECT_NONE_VALUE}
                          disabled={isLeadMode}
                        >
                          <FormControl>
                            <SelectTrigger className="rounded-none" data-testid="select-customer-manager">
                              <SelectValue placeholder={isLeadMode ? "등록자 선택" : "담당자 선택"} />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="rounded-none">
                            <SelectItem value={SELECT_NONE_VALUE}>선택 안함</SelectItem>
                            {managerOptions.map((managerName) => (
                              <SelectItem key={managerName} value={managerName}>
                                {managerName}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <div className="flex flex-wrap items-center gap-2">
                          <FormLabel>전화번호{isLeadMode && !isEditMode ? " *" : ""}</FormLabel>
                          <span className="text-[11px] text-muted-foreground">
                            번호가 없으면 010-0000-0000 입력, 이 번호는 중복 허용
                          </span>
                        </div>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value || ""}
                            placeholder="010-0000-0000"
                            className="rounded-none"
                            data-testid="input-customer-phone"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>이메일</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value || ""}
                            placeholder="example@company.com"
                            className="rounded-none"
                            data-testid="input-customer-email"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="company"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>담당자</FormLabel>
                        <FormControl>
                          <Input
                            {...field}
                            value={field.value || ""}
                            placeholder="담당자를 입력하세요"
                            className="rounded-none"
                            data-testid="input-customer-company"
                          />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="serviceType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>서비스유형</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === SELECT_NONE_VALUE ? "" : value)}
                          value={field.value && field.value.length > 0 ? field.value : SELECT_NONE_VALUE}
                        >
                          <FormControl>
                            <SelectTrigger className="rounded-none" data-testid="select-service-type">
                              <SelectValue placeholder="서비스유형 선택" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="rounded-none">
                            <SelectItem value={SELECT_NONE_VALUE}>선택 안함</SelectItem>
                            <SelectItem value="슬롯">슬롯</SelectItem>
                            <SelectItem value="월보장">월보장</SelectItem>
                            <SelectItem value="바이럴">바이럴</SelectItem>
                            <SelectItem value="종합마케팅">종합마케팅</SelectItem>
                            <SelectItem value="기타">기타</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="customerType"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{isLeadMode ? "리드구분" : "고객구분"}</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === SELECT_NONE_VALUE ? "" : value)}
                          value={isLeadMode ? field.value && field.value.length > 0 ? field.value : LEAD_TYPE_DEFAULT : "계약완료"}
                          disabled={!isLeadMode}
                        >
                          <FormControl>
                            <SelectTrigger className="rounded-none" data-testid="select-customer-type">
                              <SelectValue placeholder="고객구분 선택" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="rounded-none">
                            {!isLeadMode ? <SelectItem value={SELECT_NONE_VALUE}>선택 안함</SelectItem> : null}
                            <SelectItem value="가망">가망</SelectItem>
                            {!isLeadMode ? <SelectItem value="계약완료">계약완료</SelectItem> : null}
                            <SelectItem value="종료">종료</SelectItem>
                            <SelectItem value="기타">기타</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />

                  <FormField
                    control={form.control}
                    name="customerCategory"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>{isLeadMode ? "리드유형" : "고객유형"}</FormLabel>
                        <Select
                          onValueChange={(value) => field.onChange(value === SELECT_NONE_VALUE ? "" : value)}
                          value={isLeadMode ? normalizeLeadCategory(field.value) : field.value && field.value.length > 0 ? field.value : SELECT_NONE_VALUE}
                        >
                          <FormControl>
                            <SelectTrigger className="rounded-none" data-testid="select-customer-category">
                              <SelectValue placeholder="고객유형 선택" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="rounded-none">
                            {!isLeadMode ? <SelectItem value={SELECT_NONE_VALUE}>선택 안함</SelectItem> : null}
                            <SelectItem value={isLeadMode ? LEAD_CATEGORY_DEFAULT : "고객사"}>{isLeadMode ? LEAD_CATEGORY_DEFAULT : "고객사"}</SelectItem>
                            <SelectItem value="대행사">대행사</SelectItem>
                            <SelectItem value="총판">총판</SelectItem>
                            <SelectItem value="실행사">실행사</SelectItem>
                            <SelectItem value="기타">기타</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>

                <FormField
                  control={form.control}
                  name="notes"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>메모</FormLabel>
                      <FormControl>
                        <Textarea
                          {...field}
                          value={field.value || ""}
                          placeholder={`${noun} 관련 메모를 입력하세요`}
                          className="min-h-[90px] rounded-none"
                          data-testid="textarea-customer-notes"
                        />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />

                <div className="flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    className="rounded-none"
                    onClick={() => onOpenChange(false)}
                    data-testid="button-customer-cancel"
                  >
                    닫기
                  </Button>
                  <Button
                    type="submit"
                    className="rounded-none"
                    disabled={saveCustomerMutation.isPending}
                    data-testid="button-customer-save"
                  >
                    {saveCustomerMutation.isPending ? "저장 중..." : isEditMode ? "수정 저장" : "등록 저장"}
                  </Button>
                </div>
              </form>
            </Form>

            {!isLeadMode && isEditMode ? (
              <>
                <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
                  <Card className="rounded-none">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">계약 수</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-lg font-semibold" data-testid="text-summary-contract-count">
                        {summary.contractCount.toLocaleString("ko-KR")}건
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="rounded-none">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">계약금액</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-lg font-semibold" data-testid="text-summary-contract-amount">
                        {formatCurrency(summary.contractAmount)}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="rounded-none">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">입금금액</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-lg font-semibold text-blue-600" data-testid="text-summary-deposit-amount">
                        {formatCurrency(summary.depositAmount)}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="rounded-none">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">미수금</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-lg font-semibold text-red-600" data-testid="text-summary-receivable-amount">
                        {formatCurrency(summary.receivableAmount)}
                      </p>
                    </CardContent>
                  </Card>

                  <Card className="rounded-none">
                    <CardHeader className="pb-2">
                      <CardTitle className="text-xs font-medium text-muted-foreground">환불금액</CardTitle>
                    </CardHeader>
                    <CardContent>
                      <p className="text-lg font-semibold text-red-600" data-testid="text-summary-refund-amount">
                        {formatCurrency(summary.refundAmount)}
                      </p>
                    </CardContent>
                  </Card>

                </div>

              </>
            ) : !isLeadMode ? (
              <div className="rounded-md border p-4 text-sm text-muted-foreground">
                고객사를 저장하면 계약 요약(계약 수/계약금액/환불금액/입금금액/미수금)이 자동 표시됩니다.
              </div>
            ) : null}
          </TabsContent>

          <TabsContent value="contracts">
            {!isEditMode ? (
              emptyTabGuide("계약관리")
            ) : contractsLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : customerContracts.length === 0 ? (
              <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
                연결된 계약이 없습니다.
              </div>
            ) : (
              <div className="max-h-[460px] overflow-auto border">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>계약일</TableHead>
                      <TableHead>상품</TableHead>
                      <TableHead className="text-right">계약금액</TableHead>
                      <TableHead className="text-right">환불금액</TableHead>
                      <TableHead className="text-right">입금금액</TableHead>
                      <TableHead className="text-right">미수금</TableHead>
                      <TableHead>결제상태</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {customerContracts.map((contract) => {
                      const contractAmount = toNumber(contract.cost);
                      const refundAmount = toNumber(contract.totalRefund);
                      const linkedDepositAmount = depositAmountByContractId.get(String(contract.id)) || 0;
                      const depositAmount = linkedDepositAmount > 0
                        ? linkedDepositAmount
                        : normalizePaymentDisplay(contract.paymentMethod) === "입금완료" || contract.paymentConfirmed === true
                          ? Math.max(0, contractAmount - refundAmount)
                          : 0;
                      const receivableAmount = Math.max(0, contractAmount - refundAmount - depositAmount);
                      return (
                        <TableRow key={contract.id}>
                          <TableCell className="text-xs">{formatDate(contract.contractDate)}</TableCell>
                          <TableCell className="text-xs">{contract.products || "-"}</TableCell>
                          <TableCell className="text-right text-xs">{formatCurrency(contractAmount)}</TableCell>
                          <TableCell className="text-right text-xs">{formatCurrency(refundAmount)}</TableCell>
                          <TableCell className="text-right text-xs text-blue-600">{formatCurrency(depositAmount)}</TableCell>
                          <TableCell className="text-right text-xs text-red-600">{formatCurrency(receivableAmount)}</TableCell>
                          <TableCell className="text-xs">{normalizePaymentDisplay(contract.paymentMethod) || "-"}</TableCell>
                        </TableRow>
                      );
                    })}
                  </TableBody>
                </Table>
              </div>
            )}
          </TabsContent>

          <TabsContent value="counseling" className="space-y-4">
            {!isEditMode ? (
              emptyTabGuide("고객상담")
            ) : (
              <>
                <Form {...counselingForm}>
                  <form
                    onSubmit={counselingForm.handleSubmit(handleCreateCounseling)}
                    className="rounded-none border p-4"
                  >
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-[180px_1fr_auto]">
                      <FormField
                        control={counselingForm.control}
                        name="counselingDate"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>상담 일자</FormLabel>
                            <FormControl>
                              <Input
                                {...field}
                                type="date"
                                className="rounded-none"
                                data-testid="input-counseling-date"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <FormField
                        control={counselingForm.control}
                        name="content"
                        render={({ field }) => (
                          <FormItem>
                            <FormLabel>상담 내용</FormLabel>
                            <FormControl>
                              <Textarea
                                {...field}
                                placeholder="고객 상담 내용을 입력하세요"
                                className="min-h-[76px] rounded-none"
                                data-testid="textarea-counseling-content"
                              />
                            </FormControl>
                            <FormMessage />
                          </FormItem>
                        )}
                      />

                      <div className="flex items-end">
                        <Button
                          type="submit"
                          className="rounded-none"
                          disabled={createCounselingMutation.isPending}
                          data-testid="button-add-counseling"
                        >
                          {createCounselingMutation.isPending ? "등록 중..." : "상담 등록"}
                        </Button>
                      </div>
                    </div>
                  </form>
                </Form>

                <Card className="rounded-none">
                  <CardHeader>
                    <CardTitle className="text-sm">상담 히스토리</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {counselingLoading ? (
                      <Skeleton className="h-24 w-full" />
                    ) : counselingHistory.length === 0 ? (
                      <p className="text-sm text-muted-foreground">등록된 상담 이력이 없습니다.</p>
                    ) : (
                      <div className="max-h-[320px] overflow-auto border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>등록시각</TableHead>
                              <TableHead>내용</TableHead>
                              <TableHead>등록자</TableHead>
                              <TableHead className="w-[80px] text-right">관리</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {counselingHistory.map((row) => (
                              <TableRow key={row.id}>
                                <TableCell className="text-xs whitespace-nowrap">{formatDateTime(row.createdAt)}</TableCell>
                                <TableCell className="text-xs max-w-[320px]">
                                  {row.content.trim().length > 60 || row.content.includes("\n") ? (
                                    <Popover>
                                      <PopoverTrigger asChild>
                                        <button
                                          type="button"
                                          className="block max-w-[320px] truncate text-left hover:underline"
                                          onClick={() => handleApplyCounselingContent(row)}
                                          data-testid={`button-counseling-detail-${row.id}`}
                                        >
                                          {truncatePreviewText(row.content)}
                                        </button>
                                      </PopoverTrigger>
                                      <PopoverContent className="w-[420px] rounded-none text-sm whitespace-pre-wrap break-all">
                                        {row.content}
                                      </PopoverContent>
                                    </Popover>
                                  ) : (
                                    <button
                                      type="button"
                                      className="whitespace-pre-wrap break-all text-left hover:underline"
                                      onClick={() => handleApplyCounselingContent(row)}
                                      data-testid={`button-counseling-apply-${row.id}`}
                                    >
                                      {row.content}
                                    </button>
                                  )}
                                </TableCell>
                                <TableCell className="text-xs">{row.createdBy || "-"}</TableCell>
                                <TableCell className="text-right">
                                  <Button
                                    variant="ghost"
                                    size="icon"
                                    className="h-7 w-7 rounded-none"
                                    onClick={() => handleDeleteCounseling(row.id)}
                                    disabled={deleteCounselingMutation.isPending}
                                    data-testid={`button-delete-counseling-${row.id}`}
                                  >
                                    <X className="h-4 w-4" />
                                  </Button>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>

          <TabsContent value="history">
            {!isEditMode ? (
              emptyTabGuide("변경이력")
            ) : historyLoading ? (
              <Skeleton className="h-32 w-full" />
            ) : changeHistory.length === 0 ? (
              <div className="rounded-md border p-6 text-center text-sm text-muted-foreground">
                고객 정보 변경 이력이 없습니다.
              </div>
            ) : (
              <div className="max-h-[500px] overflow-auto space-y-3">
                {changeHistory.map((row) => {
                  const changedKeys = (row.changedFields || "")
                    .split(",")
                    .map((key) => key.trim())
                    .filter(Boolean);
                  const beforeData = parseObjectText(row.beforeData);
                  const afterData = parseObjectText(row.afterData);

                  return (
                    <Card key={row.id} className="rounded-none">
                      <CardHeader className="pb-2">
                        <CardTitle className="text-sm">
                          {formatDateTime(row.createdAt)} / {row.createdBy || "시스템"}
                        </CardTitle>
                      </CardHeader>
                      <CardContent className="space-y-1 text-xs">
                        {changedKeys.length === 0 ? (
                          <p className="text-muted-foreground">변경 필드 정보가 없습니다.</p>
                        ) : (
                          changedKeys.map((key) => (
                            <p key={`${row.id}-${key}`}>
                              <span className="font-medium">{fieldLabel(key)}:</span>{" "}
                              <span className="text-muted-foreground">{displayValue(beforeData[key])}</span>
                              {" → "}
                              <span>{displayValue(afterData[key])}</span>
                            </p>
                          ))
                        )}
                      </CardContent>
                    </Card>
                  );
                })}
              </div>
            )}
          </TabsContent>

          <TabsContent value="files" className="space-y-4">
            {!isEditMode ? (
              emptyTabGuide("파일")
            ) : (
              <>
                <Card className="rounded-none">
                  <CardHeader>
                    <CardTitle className="text-sm">관련 파일 등록</CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-3">
                    <div className="flex flex-col gap-2">
                      <Input
                        type="file"
                        className="rounded-none"
                        onChange={(event) => setSelectedFile(event.target.files?.[0] ?? null)}
                        data-testid="input-customer-file"
                      />
                      <Input
                        value={fileNote}
                        onChange={(event) => setFileNote(event.target.value)}
                        placeholder="어떤 파일인지 비고를 입력하세요"
                        className="rounded-none"
                        maxLength={200}
                        data-testid="input-customer-file-note"
                      />
                      <Button
                        type="button"
                        className="rounded-none self-start"
                        onClick={handleUploadFile}
                        disabled={!selectedFile || !canUploadMore || uploadFileMutation.isPending}
                        data-testid="button-upload-customer-file"
                      >
                        <Upload className="mr-1 h-4 w-4" />
                        {uploadFileMutation.isPending ? "업로드 중..." : "파일 업로드"}
                      </Button>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      파일은 최대 5개까지 등록할 수 있습니다. 현재 {customerFiles.length}/5
                    </p>
                  </CardContent>
                </Card>

                <Card className="rounded-none">
                  <CardHeader>
                    <CardTitle className="text-sm">등록 파일 목록</CardTitle>
                  </CardHeader>
                  <CardContent>
                    {filesLoading ? (
                      <Skeleton className="h-24 w-full" />
                    ) : customerFiles.length === 0 ? (
                      <p className="text-sm text-muted-foreground">등록된 파일이 없습니다.</p>
                    ) : (
                      <div className="max-h-[320px] overflow-auto border">
                        <Table>
                          <TableHeader>
                            <TableRow>
                              <TableHead>파일명</TableHead>
                              <TableHead>비고</TableHead>
                              <TableHead>크기</TableHead>
                              <TableHead>업로드자</TableHead>
                              <TableHead>업로드일</TableHead>
                              <TableHead className="text-right">관리</TableHead>
                            </TableRow>
                          </TableHeader>
                          <TableBody>
                            {customerFiles.map((file) => (
                              <TableRow key={file.id}>
                                <TableCell className="text-xs break-all max-w-[240px]">{file.fileName}</TableCell>
                                <TableCell className="text-xs max-w-[220px] whitespace-pre-wrap break-all">{file.note || "-"}</TableCell>
                                <TableCell className="text-xs">{formatFileSize(file.sizeBytes)}</TableCell>
                                <TableCell className="text-xs">{file.uploadedBy || "-"}</TableCell>
                                <TableCell className="text-xs">{formatDateTime(file.createdAt)}</TableCell>
                                <TableCell className="text-right">
                                  <div className="inline-flex gap-1">
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 rounded-none"
                                      onClick={() => handleDownloadFile(file.id)}
                                      data-testid={`button-download-customer-file-${file.id}`}
                                    >
                                      <Download className="h-4 w-4" />
                                    </Button>
                                    <Button
                                      variant="ghost"
                                      size="icon"
                                      className="h-7 w-7 rounded-none"
                                      onClick={() => handleDeleteFile(file.id)}
                                      disabled={deleteFileMutation.isPending}
                                      data-testid={`button-delete-customer-file-${file.id}`}
                                    >
                                      <Trash2 className="h-4 w-4" />
                                    </Button>
                                  </div>
                                </TableCell>
                              </TableRow>
                            ))}
                          </TableBody>
                        </Table>
                      </div>
                    )}
                  </CardContent>
                </Card>
              </>
            )}
          </TabsContent>
        </Tabs>
      </DialogContent>
    </Dialog>
  );
}
