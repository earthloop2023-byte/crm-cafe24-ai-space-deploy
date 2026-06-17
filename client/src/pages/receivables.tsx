import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Checkbox } from "@/components/ui/checkbox";
import { DatePeriodFilter } from "@/components/date-period-filter";
import { AlertCircle, Search, Download, Filter, RefreshCw } from "lucide-react";
import { Pagination } from "@/components/pagination";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import type { Contract, Deposit } from "@shared/schema";
import { getKoreanDateKey, getKoreanEndOfDay, getKoreanStartOfMonth, getKoreanStartOfYear } from "@/lib/korean-time";
import { useSettings } from "@/lib/settings";
import { useToast } from "@/hooks/use-toast";
import { matchesKoreanSearch } from "@shared/korean-search";
import { getContractGrossAmount } from "@/lib/contract-financials";

type ReceivableStatus = "미수" | "초과/환불확인";

type ReceivableRow = {
  rowKey: string;
  status: ReceivableStatus;
  contract: Contract;
  contractAmount: number;
  mappedAmount: number;
  customerTotalAmount: number;
  customerConfirmedAmount: number;
  customerDifferenceAmount: number;
  reason: string;
};

const CONTRACT_TYPE_REFUND = "refund";
const PAYMENT_METHOD_DEPOSIT_CONFIRMED = "입금완료";

const normalizeText = (value: unknown) => String(value ?? "").trim();
const normalizeCompactText = (value: unknown) => normalizeText(value).replace(/\s+/g, "");
const formatAmount = (amount: number) => new Intl.NumberFormat("ko-KR").format(Math.round(Math.abs(amount || 0)));
const signedFormatAmount = (amount: number) => `${amount < 0 ? "-" : ""}${formatAmount(amount)}`;

function normalizePaymentMethod(value: unknown) {
  const normalized = normalizeCompactText(value);
  const asciiKey = normalized.replace(/[_-]/g, "").toLowerCase();
  if (
    normalized === PAYMENT_METHOD_DEPOSIT_CONFIRMED ||
    normalized === "입금확인" ||
    normalized === "입금완료" ||
    normalized === "하나" ||
    normalized === "하나은행" ||
    normalized === "국민" ||
    normalized === "국민은행" ||
    normalized === "농협" ||
    normalized === "농협은행" ||
    normalized === "크몽" ||
    ["deposit", "deposited", "confirmed", "banktransfer", "transfer", "hana", "hanabank", "kb", "kookmin", "nonghyup", "nh", "kmong"].includes(asciiKey)
  ) {
    return PAYMENT_METHOD_DEPOSIT_CONFIRMED;
  }
  return normalized;
}

function isRefundContract(contract: Contract) {
  return normalizeText((contract as Contract & { contractType?: string | null }).contractType) === CONTRACT_TYPE_REFUND ||
    (Number(contract.cost) || 0) < 0;
}

function isWithdrawnContract(contract: Contract) {
  return normalizeText((contract as Contract & { contractStatus?: string | null }).contractStatus).toLowerCase() === "withdrawn";
}

function getSignedContractAmount(contract: Contract) {
  const rawCost = Math.round(Number(contract.cost) || 0);
  const grossAmount = Math.round(getContractGrossAmount({ ...contract, cost: Math.abs(rawCost) }));
  if (isRefundContract(contract) || rawCost < 0) {
    return -grossAmount;
  }
  return grossAmount;
}

function getPositiveContractAmount(contract: Contract) {
  return Math.max(0, getSignedContractAmount(contract));
}

function isDepositConfirmedContract(contract: Contract) {
  return contract.paymentConfirmed === true || normalizePaymentMethod(contract.paymentMethod) === PAYMENT_METHOD_DEPOSIT_CONFIRMED;
}

function getDepositAmount(deposit: Deposit | null | undefined) {
  if (!deposit) return 0;
  const confirmedAmount = Math.max(0, Math.round(Number(deposit.confirmedAmount) || 0));
  if (confirmedAmount > 0) return confirmedAmount;
  return Math.max(0, Math.round(Number(deposit.depositAmount) || 0));
}

function isConfirmedDeposit(deposit: Deposit | null | undefined) {
  if (!deposit) return false;
  return Boolean(deposit.confirmedAt || getDepositAmount(deposit) > 0 || deposit.contractId);
}

function getContractConfirmedAmount(contract: Contract, linkedDeposit: Deposit | undefined) {
  if (isRefundContract(contract)) return 0;
  if (isConfirmedDeposit(linkedDeposit)) return getDepositAmount(linkedDeposit);
  return isDepositConfirmedContract(contract) ? getPositiveContractAmount(contract) : 0;
}

function getRowAmountClassName(amount: number) {
  if (amount < 0) return "text-blue-600";
  return "text-red-600";
}

function getStatusClassName(status: ReceivableStatus) {
  if (status === "초과/환불확인") {
    return "inline-flex items-center rounded-full border border-blue-200 bg-blue-50 px-2 py-0.5 text-[11px] font-semibold text-blue-700";
  }
  return "inline-flex items-center rounded-full border border-red-200 bg-red-50 px-2 py-0.5 text-[11px] font-semibold text-red-700";
}

export default function ReceivablesPage() {
  const { toast } = useToast();
  const { formatDate } = useSettings();
  const [searchQuery, setSearchQuery] = useState("");
  const deferredSearchQuery = useDeferredValue(searchQuery);
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [startDate, setStartDate] = useState<Date>(getKoreanStartOfMonth());
  const [endDate, setEndDate] = useState<Date>(getKoreanEndOfDay());
  const [customerFilter, setCustomerFilter] = useState("all");
  const [managerFilter, setManagerFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [selectedReceivableRowKeys, setSelectedReceivableRowKeys] = useState<Set<string>>(new Set());

  const { data: allContracts = [], isLoading: contractsLoading } = useQuery<Contract[]>({
    queryKey: ["/api/contracts"],
  });

  const { data: deposits = [], isLoading: depositsLoading } = useQuery<Deposit[]>({
    queryKey: ["/api/deposits"],
  });

  const depositByContractId = useMemo(() => {
    const map = new Map<string, Deposit>();
    for (const deposit of deposits) {
      const contractId = normalizeText(deposit.contractId);
      if (!contractId || map.has(contractId)) continue;
      map.set(contractId, deposit);
    }
    return map;
  }, [deposits]);

  const receivableRows = useMemo(() => {
    const grouped = new Map<string, Contract[]>();
    for (const contract of allContracts) {
      if (isWithdrawnContract(contract)) continue;
      const customerKey = normalizeCompactText(contract.customerName);
      if (!customerKey) continue;
      if (!grouped.has(customerKey)) grouped.set(customerKey, []);
      grouped.get(customerKey)!.push(contract);
    }

    const rows: ReceivableRow[] = [];

    grouped.forEach((contracts, customerKey) => {
      const sortedContracts = [...contracts].sort(
        (a, b) => new Date(a.contractDate).getTime() - new Date(b.contractDate).getTime(),
      );
      const customerTotalAmount = sortedContracts.reduce((sum, contract) => sum + getSignedContractAmount(contract), 0);
      const customerConfirmedAmount = sortedContracts.reduce(
        (sum, contract) => sum + getContractConfirmedAmount(contract, depositByContractId.get(contract.id)),
        0,
      );
      const customerDifferenceAmount = customerTotalAmount - customerConfirmedAmount;

      if (Math.abs(customerDifferenceAmount) < 1) return;

      if (customerDifferenceAmount > 0) {
        let remainingAmount = customerDifferenceAmount;
        const candidates = sortedContracts
          .filter((contract) => !isRefundContract(contract) && getPositiveContractAmount(contract) > 0)
          .map((contract) => {
            const confirmedAmount = getContractConfirmedAmount(contract, depositByContractId.get(contract.id));
            return {
              contract,
              openAmount: Math.max(0, getPositiveContractAmount(contract) - confirmedAmount),
            };
          })
          .filter((entry) => entry.openAmount > 0);

        const mappingTargets = candidates.length > 0
          ? candidates
          : sortedContracts
            .filter((contract) => !isRefundContract(contract) && getPositiveContractAmount(contract) > 0)
            .map((contract) => ({ contract, openAmount: Math.min(getPositiveContractAmount(contract), remainingAmount) }));

        for (const entry of mappingTargets) {
          if (remainingAmount <= 0) break;
          const mappedAmount = Math.min(entry.openAmount, remainingAmount);
          if (mappedAmount <= 0) continue;
          rows.push({
            rowKey: `${customerKey}:${entry.contract.id}:receivable:${rows.length}`,
            status: "미수",
            contract: entry.contract,
            contractAmount: getSignedContractAmount(entry.contract),
            mappedAmount,
            customerTotalAmount,
            customerConfirmedAmount,
            customerDifferenceAmount,
            reason: "고객 순계약금액보다 입금완료 금액이 부족합니다.",
          });
          remainingAmount -= mappedAmount;
        }
      } else {
        let remainingAmount = Math.abs(customerDifferenceAmount);
        const refundContracts = sortedContracts
          .filter(isRefundContract)
          .sort((a, b) => new Date(b.contractDate).getTime() - new Date(a.contractDate).getTime());

        const mappingTargets = refundContracts.length > 0 ? refundContracts : sortedContracts.slice(-1);
        for (const contract of mappingTargets) {
          if (remainingAmount <= 0) break;
          const basisAmount = Math.max(1, Math.abs(getSignedContractAmount(contract)));
          const mappedAmount = -Math.min(basisAmount, remainingAmount);
          rows.push({
            rowKey: `${customerKey}:${contract.id}:overpaid:${rows.length}`,
            status: "초과/환불확인",
            contract,
            contractAmount: getSignedContractAmount(contract),
            mappedAmount,
            customerTotalAmount,
            customerConfirmedAmount,
            customerDifferenceAmount,
            reason: "환불 계약 반영 후 입금완료 금액이 순계약금액보다 큽니다.",
          });
          remainingAmount -= Math.abs(mappedAmount);
        }
      }
    });

    return rows.sort((a, b) => new Date(b.contract.contractDate).getTime() - new Date(a.contract.contractDate).getTime());
  }, [allContracts, depositByContractId]);

  const filteredReceivables = useMemo(() => {
    const query = normalizeText(deferredSearchQuery);
    const startKey = getKoreanDateKey(startDate);
    const endKey = getKoreanDateKey(endDate);
    const rangeStart = startKey <= endKey ? startKey : endKey;
    const rangeEnd = startKey <= endKey ? endKey : startKey;

    return receivableRows.filter((row) => {
      const dateKey = getKoreanDateKey(row.contract.contractDate);
      if (dateKey < rangeStart || dateKey > rangeEnd) return false;
      if (customerFilter !== "all" && row.contract.customerName !== customerFilter) return false;
      if (managerFilter !== "all" && row.contract.managerName !== managerFilter) return false;
      if (statusFilter !== "all" && row.status !== statusFilter) return false;
      if (!query) return true;
      return matchesKoreanSearch(
        [
          row.contract.customerName,
          row.contract.userIdentifier,
          row.contract.managerName,
          row.contract.products,
          row.contract.worker,
          row.contract.notes,
          row.status,
          row.reason,
        ],
        query,
      );
    });
  }, [customerFilter, deferredSearchQuery, endDate, managerFilter, receivableRows, startDate, statusFilter]);

  const uniqueCustomers = useMemo(
    () => Array.from(new Set(receivableRows.map((row) => row.contract.customerName).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko")),
    [receivableRows],
  );
  const uniqueManagers = useMemo(
    () => Array.from(new Set(receivableRows.map((row) => row.contract.managerName).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko")),
    [receivableRows],
  );

  const totalPages = Math.max(1, Math.ceil(filteredReceivables.length / itemsPerPage));
  const paginatedReceivables = filteredReceivables.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const currentPageReceivableKeys = paginatedReceivables.map((row) => row.rowKey);
  const isCurrentPageAllSelected = currentPageReceivableKeys.length > 0 &&
    currentPageReceivableKeys.every((key) => selectedReceivableRowKeys.has(key));
  const selectedReceivables = filteredReceivables.filter((row) => selectedReceivableRowKeys.has(row.rowKey));
  const totalReceivableAmount = filteredReceivables.reduce((sum, row) => sum + Math.max(row.mappedAmount, 0), 0);
  const totalOverpaidAmount = filteredReceivables.reduce((sum, row) => sum + Math.abs(Math.min(row.mappedAmount, 0)), 0);
  const isLoading = contractsLoading || depositsLoading;

  useEffect(() => {
    setSelectedReceivableRowKeys((prev) => {
      const visibleKeys = new Set(filteredReceivables.map((row) => row.rowKey));
      const next = new Set(Array.from(prev).filter((key) => visibleKeys.has(key)));
      return next.size === prev.size ? prev : next;
    });
  }, [filteredReceivables]);

  const resetFilters = () => {
    setSearchQuery("");
    setCustomerFilter("all");
    setManagerFilter("all");
    setStatusFilter("all");
    setStartDate(getKoreanStartOfYear());
    setEndDate(getKoreanEndOfDay());
    setCurrentPage(1);
    setSelectedReceivableRowKeys(new Set());
  };

  const toggleReceivableSelection = (rowKey: string) => {
    setSelectedReceivableRowKeys((prev) => {
      const next = new Set(prev);
      if (next.has(rowKey)) next.delete(rowKey);
      else next.add(rowKey);
      return next;
    });
  };

  const toggleSelectAllOnCurrentPage = () => {
    setSelectedReceivableRowKeys((prev) => {
      const next = new Set(prev);
      if (isCurrentPageAllSelected) {
        currentPageReceivableKeys.forEach((key) => next.delete(key));
      } else {
        currentPageReceivableKeys.forEach((key) => next.add(key));
      }
      return next;
    });
  };

  const handleExcelDownload = () => {
    if (selectedReceivables.length === 0) {
      toast({ title: "엑셀로 내보낼 항목을 먼저 선택해주세요.", variant: "destructive" });
      return;
    }

    const worksheet = XLSX.utils.json_to_sheet(
      selectedReceivables.map((row) => ({
        계약일: formatDate(row.contract.contractDate),
        고객명: row.contract.customerName,
        사용자ID: row.contract.userIdentifier || "-",
        상품: row.contract.products || "-",
        구분: row.status,
        계약금액: row.contractAmount,
        고객순계약액: row.customerTotalAmount,
        입금완료액: row.customerConfirmedAmount,
        차액: row.customerDifferenceAmount,
        매핑금액: row.mappedAmount,
        담당자: row.contract.managerName || "-",
        작업자: row.contract.worker || "-",
        매핑사유: row.reason,
        비고: row.contract.notes || "",
      })),
    );
    worksheet["!cols"] = [
      { wch: 12 },
      { wch: 20 },
      { wch: 18 },
      { wch: 28 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 14 },
      { wch: 12 },
      { wch: 12 },
      { wch: 36 },
      { wch: 30 },
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "미수금");
    XLSX.writeFile(workbook, `미수금_선택목록_${format(new Date(), "yyyyMMdd_HHmmss")}.xlsx`);
    toast({ title: `${selectedReceivables.length}건을 엑셀로 내보냈습니다.` });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <AlertCircle className="w-6 h-6 text-red-500" />
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">미수금 관리</h1>
            <p className="mt-1 text-xs text-muted-foreground">고객별 순계약금액(환불 포함)과 입금완료 금액의 차이를 계약에 매핑합니다.</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm" data-testid="text-result-count">
            검색 결과 {filteredReceivables.length}건 | 총 미수{" "}
            <span className="text-red-500 font-bold text-base" data-testid="text-total-receivable">
              {formatAmount(totalReceivableAmount)}원
            </span>
            {totalOverpaidAmount > 0 && (
              <span className="ml-2 text-blue-600 font-bold text-base" data-testid="text-total-overpaid">
                초과/환불확인 {formatAmount(totalOverpaidAmount)}원
              </span>
            )}
          </span>
          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="고객명, 사용자ID, 상품, 담당자 검색"
              value={searchQuery}
              onChange={(event) => {
                setSearchQuery(event.target.value);
                setCurrentPage(1);
              }}
              className="pl-9 w-64 rounded-none"
              data-testid="input-search"
            />
          </div>
          <Button
            variant="outline"
            className="gap-2 rounded-none"
            onClick={handleExcelDownload}
            disabled={selectedReceivables.length === 0}
            data-testid="button-excel-download"
          >
            <Download className="w-4 h-4" />
            엑셀 다운로드 ({selectedReceivables.length})
          </Button>
        </div>
      </div>

      <div className="flex items-center gap-2 p-3 bg-card border border-border rounded-none flex-wrap">
        <Button variant="ghost" size="sm" className="gap-1 rounded-none">
          <Filter className="w-4 h-4" />
          필터
        </Button>
        <DatePeriodFilter
          startDate={startDate}
          endDate={endDate}
          onStartDateChange={setStartDate}
          onEndDateChange={setEndDate}
          onReset={resetFilters}
        />

        <Select
          value={customerFilter}
          onValueChange={(value) => {
            setCustomerFilter(value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-36 rounded-none" data-testid="filter-customer">
            <SelectValue placeholder="고객명" />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="all">전체</SelectItem>
            {uniqueCustomers.map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={managerFilter}
          onValueChange={(value) => {
            setManagerFilter(value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-36 rounded-none" data-testid="filter-manager">
            <SelectValue placeholder="담당자" />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="all">전체</SelectItem>
            {uniqueManagers.map((name) => (
              <SelectItem key={name} value={name}>{name}</SelectItem>
            ))}
          </SelectContent>
        </Select>

        <Select
          value={statusFilter}
          onValueChange={(value) => {
            setStatusFilter(value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-40 rounded-none" data-testid="filter-status">
            <SelectValue placeholder="구분" />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="all">전체</SelectItem>
            <SelectItem value="미수">미수</SelectItem>
            <SelectItem value="초과/환불확인">초과/환불확인</SelectItem>
          </SelectContent>
        </Select>

        <Button
          variant="ghost"
          size="sm"
          className="ml-auto text-muted-foreground rounded-none"
          onClick={resetFilters}
          data-testid="button-reset-filter"
        >
          <RefreshCw className="w-4 h-4 mr-1" />
          초기화
        </Button>
      </div>

      <Card className="rounded-none">
        <CardContent className="p-0">
          <div className="overflow-x-auto">
            <table className="w-full">
              <thead>
                <tr className="border-b border-border bg-muted/30">
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">
                    <Checkbox
                      checked={isCurrentPageAllSelected}
                      onCheckedChange={toggleSelectAllOnCurrentPage}
                      data-testid="checkbox-select-all-receivables"
                    />
                  </th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">계약일</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">고객명</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">사용자ID</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">상품</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">구분</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">계약금액</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">고객 순계약액</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">입금완료액</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">차액 매핑</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">담당자</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">작업자</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">매핑사유</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">비고</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, rowIndex) => (
                    <tr key={rowIndex} className="border-b border-border">
                      {Array.from({ length: 14 }).map((__, cellIndex) => (
                        <td key={cellIndex} className="p-4">
                          <Skeleton className="h-4 w-20" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : paginatedReceivables.length === 0 ? (
                  <tr>
                    <td colSpan={14} className="p-12 text-center text-muted-foreground">
                      미수금 또는 환불 차액이 없습니다.
                    </td>
                  </tr>
                ) : (
                  paginatedReceivables.map((row) => (
                    <tr key={row.rowKey} className="border-b border-border hover:bg-muted/20 transition-colors" data-testid={`row-receivable-${row.contract.id}`}>
                      <td className="p-4">
                        <Checkbox
                          checked={selectedReceivableRowKeys.has(row.rowKey)}
                          onCheckedChange={() => toggleReceivableSelection(row.rowKey)}
                          data-testid={`checkbox-receivable-${row.contract.id}`}
                        />
                      </td>
                      <td className="p-4 text-xs whitespace-nowrap">{formatDate(row.contract.contractDate)}</td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.contract.customerName}</td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.contract.userIdentifier || "-"}</td>
                      <td className="p-4 text-xs max-w-[240px] text-muted-foreground">
                        <span className="truncate block" title={row.contract.products || "-"}>
                          {row.contract.products || "-"}
                        </span>
                      </td>
                      <td className="p-4 text-xs whitespace-nowrap">
                        <span className={getStatusClassName(row.status)}>{row.status}</span>
                      </td>
                      <td className={`p-4 text-xs text-right whitespace-nowrap font-medium ${row.contractAmount < 0 ? "text-rose-600" : ""}`}>
                        {signedFormatAmount(row.contractAmount)}원
                      </td>
                      <td className="p-4 text-xs text-right whitespace-nowrap">{signedFormatAmount(row.customerTotalAmount)}원</td>
                      <td className="p-4 text-xs text-right whitespace-nowrap">{formatAmount(row.customerConfirmedAmount)}원</td>
                      <td className={`p-4 text-xs text-right whitespace-nowrap font-bold ${getRowAmountClassName(row.mappedAmount)}`}>
                        {signedFormatAmount(row.mappedAmount)}원
                      </td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.contract.managerName || "-"}</td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.contract.worker || "-"}</td>
                      <td className="p-4 text-xs max-w-[260px] text-muted-foreground">
                        <span className="truncate block" title={row.reason}>{row.reason}</span>
                      </td>
                      <td className="p-4 text-xs max-w-[220px] text-muted-foreground">
                        <span className="truncate block" title={row.contract.notes || "-"}>
                          {row.contract.notes || "-"}
                        </span>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
              {paginatedReceivables.length > 0 && (
                <tfoot>
                  <tr className="bg-muted/30 border-t-2 border-border">
                    <td colSpan={9} className="p-4 text-right font-bold text-xs whitespace-nowrap">합계</td>
                    <td className="p-4 text-xs text-right whitespace-nowrap font-bold">
                      <span className="text-red-600">{formatAmount(totalReceivableAmount)}원</span>
                      {totalOverpaidAmount > 0 && <span className="ml-3 text-blue-600">-{formatAmount(totalOverpaidAmount)}원</span>}
                    </td>
                    <td className="p-4" />
                    <td className="p-4" />
                    <td className="p-4" />
                    <td className="p-4" />
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
        </CardContent>
      </Card>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <Select
          value={itemsPerPage.toString()}
          onValueChange={(value) => {
            setItemsPerPage(Number(value));
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-32 rounded-none" data-testid="select-items-per-page">
            <SelectValue />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="10">10개씩 보기</SelectItem>
            <SelectItem value="50">50개씩 보기</SelectItem>
            <SelectItem value="100">100개씩 보기</SelectItem>
            <SelectItem value="500">500개씩 보기</SelectItem>
          </SelectContent>
        </Select>

        <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
      </div>
    </div>
  );
}
