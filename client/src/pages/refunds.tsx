import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { DatePeriodFilter } from "@/components/date-period-filter";
import { RotateCcw, Search, Download, Filter, RefreshCw } from "lucide-react";
import { Pagination } from "@/components/pagination";
import { format } from "date-fns";
import * as XLSX from "xlsx";
import type { Contract } from "@shared/schema";
import { getKoreanEndOfDay, getKoreanStartOfMonth, getKoreanStartOfYear, isWithinKoreanDateRange } from "@/lib/korean-time";
import { useSettings } from "@/lib/settings";
import { formatCeilAmount } from "@/lib/utils";
import { matchesKoreanSearch } from "@shared/korean-search";
import { useToast } from "@/hooks/use-toast";
import { apiRequest, queryClient } from "@/lib/queryClient";
import { getContractGrossAmount } from "@/lib/contract-financials";

type RefundReferenceRow = {
  id: string;
  source: "계약관리" | "기존 환불관리";
  refundDate: Date | string;
  contractDate: Date | string | null;
  customerName: string;
  userIdentifier: string | null;
  products: string | null;
  days: number | null;
  targetAmount: number;
  managerName: string | null;
  quantity: number;
  refundDays: number;
  refundAmount: number;
  refundStatus: string;
  reason: string | null;
  createdBy: string | null;
  worker: string | null;
};

const CONTRACT_TYPE_REFUND = "refund";

const normalizeText = (value: unknown) => String(value ?? "").trim();
const toNumber = (value: unknown) => Number(value) || 0;
const formatAmount = (amount: number) => formatCeilAmount(Math.abs(Math.round(amount || 0)));

function isRefundContract(contract: Contract) {
  return normalizeText((contract as Contract & { contractType?: string | null }).contractType) === CONTRACT_TYPE_REFUND ||
    toNumber(contract.cost) < 0;
}

function getRefundDisplayAmount(contract: Contract) {
  const rawCost = Math.abs(toNumber(contract.cost));
  return Math.round(getContractGrossAmount({ ...contract, cost: rawCost }));
}

function getStatusClassName(status: string) {
  if (status === "환불" || status === "계약관리") {
    return "inline-flex items-center rounded-full border border-rose-200 bg-rose-50 px-2 py-0.5 text-[11px] font-semibold text-rose-700";
  }
  if (status === "환불완료") {
    return "inline-flex items-center rounded-full border border-emerald-200 bg-emerald-50 px-2 py-0.5 text-[11px] font-semibold text-emerald-700";
  }
  if (status === "환불요청") {
    return "inline-flex items-center rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[11px] font-semibold text-amber-700";
  }
  if (status === "상계처리") {
    return "inline-flex items-center rounded-full border border-sky-200 bg-sky-50 px-2 py-0.5 text-[11px] font-semibold text-sky-700";
  }
  return "inline-flex items-center rounded-full border border-border bg-muted px-2 py-0.5 text-[11px] font-medium text-muted-foreground";
}

export default function RefundsPage() {
  const { formatDate } = useSettings();
  const { toast } = useToast();
  const [searchQuery, setSearchQuery] = useState("");
  const [currentPage, setCurrentPage] = useState(1);
  const [itemsPerPage, setItemsPerPage] = useState(10);
  const [startDate, setStartDate] = useState<Date>(getKoreanStartOfMonth());
  const [endDate, setEndDate] = useState<Date>(getKoreanEndOfDay());
  const [customerFilter, setCustomerFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [refundStatusFilter, setRefundStatusFilter] = useState("all");

  const { data: allContracts = [], isLoading: contractsLoading } = useQuery<Contract[]>({
    queryKey: ["/api/contracts"],
  });

  const rows = useMemo<RefundReferenceRow[]>(() => {
    const contractRefundRows = allContracts.filter(isRefundContract).map((contract) => {
      const refundAmount = getRefundDisplayAmount(contract);
      return {
        id: `contract:${contract.id}`,
        source: "계약관리" as const,
        refundDate: contract.contractDate,
        contractDate: contract.contractDate,
        customerName: contract.customerName,
        userIdentifier: contract.userIdentifier || null,
        products: contract.products || null,
        days: contract.days ?? null,
        targetAmount: refundAmount,
        managerName: contract.managerName || null,
        quantity: Math.abs(toNumber(contract.quantity)),
        refundDays: Math.abs(toNumber(contract.days)),
        refundAmount,
        refundStatus: "환불",
        reason: contract.notes || "계약관리 환불 계약",
        createdBy: "계약관리",
        worker: contract.worker || null,
      };
    });

    return contractRefundRows.sort(
      (a, b) => new Date(b.refundDate).getTime() - new Date(a.refundDate).getTime(),
    );
  }, [allContracts]);

  const filteredRows = useMemo(() => {
    return rows.filter((row) => {
      if (!isWithinKoreanDateRange(row.refundDate, startDate, endDate)) return false;
      if (customerFilter !== "all" && row.customerName !== customerFilter) return false;
      if (sourceFilter !== "all" && row.source !== sourceFilter) return false;
      if (refundStatusFilter !== "all" && row.refundStatus !== refundStatusFilter) return false;
      if (!searchQuery.trim()) return true;
      return matchesKoreanSearch(
        [
          row.customerName,
          row.userIdentifier,
          row.products,
          row.managerName,
          row.worker,
          row.reason,
          row.createdBy,
          row.source,
          row.refundStatus,
        ],
        searchQuery,
      );
    });
  }, [customerFilter, endDate, refundStatusFilter, rows, searchQuery, sourceFilter, startDate]);

  const uniqueCustomers = useMemo(
    () => Array.from(new Set(rows.map((row) => row.customerName).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko")),
    [rows],
  );
  const uniqueStatuses = useMemo(
    () => Array.from(new Set(rows.map((row) => row.refundStatus).filter(Boolean))).sort((a, b) => a.localeCompare(b, "ko")),
    [rows],
  );

  const totalPages = Math.max(1, Math.ceil(filteredRows.length / itemsPerPage));
  const paginatedRows = filteredRows.slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage);
  const totalRefundAmount = filteredRows.reduce((sum, row) => sum + row.refundAmount, 0);
  const isLoading = contractsLoading;

  const withdrawRefundMutation = useMutation({
    mutationFn: async (refundContractId: string) => {
      await apiRequest("POST", `/api/refund-contracts/${refundContractId}/withdraw`);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/contracts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts/paged"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts-with-financials"] });
      queryClient.invalidateQueries({ queryKey: ["/api/refunds"] });
      queryClient.invalidateQueries({ queryKey: ["/api/sales-analytics"] });
      toast({ title: "환불 철회가 완료되었습니다." });
    },
    onError: (error) => {
      toast({
        title: error instanceof Error ? error.message : "환불 철회 중 오류가 발생했습니다.",
        variant: "destructive",
      });
    },
  });

  const handleWithdrawRefund = (row: RefundReferenceRow) => {
    const refundContractId = row.id.startsWith("contract:") ? row.id.slice("contract:".length) : "";
    if (!refundContractId) return;
    if (!window.confirm("환불 계약을 철회하면 계약관리의 환불내역이 삭제됩니다. 진행하시겠습니까?")) return;
    withdrawRefundMutation.mutate(refundContractId);
  };

  const resetFilters = () => {
    setSearchQuery("");
    setCustomerFilter("all");
    setSourceFilter("all");
    setRefundStatusFilter("all");
    setStartDate(getKoreanStartOfYear());
    setEndDate(getKoreanEndOfDay());
    setCurrentPage(1);
  };

  const handleExcelDownload = () => {
    if (filteredRows.length === 0) {
      toast({ title: "내보낼 환불 참고 데이터가 없습니다.", variant: "destructive" });
      return;
    }

    const worksheet = XLSX.utils.json_to_sheet(
      filteredRows.map((row) => ({
        구분: row.source,
        환불일: formatDate(row.refundDate),
        계약일: row.contractDate ? formatDate(row.contractDate) : "-",
        고객명: row.customerName,
        사용자ID: row.userIdentifier || "-",
        상품: row.products || "-",
        일수: row.days || 0,
        수량: row.quantity || 0,
        기준금액: row.targetAmount,
        담당자: row.managerName || "-",
        환불개수: row.quantity,
        환불일수: row.refundDays,
        환불금액: -row.refundAmount,
        상태: row.refundStatus,
        사유: row.reason || "",
        처리자: row.createdBy || "",
      })),
    );
    worksheet["!cols"] = [
      { wch: 14 },
      { wch: 12 },
      { wch: 12 },
      { wch: 20 },
      { wch: 18 },
      { wch: 26 },
      { wch: 8 },
      { wch: 8 },
      { wch: 14 },
      { wch: 12 },
      { wch: 10 },
      { wch: 10 },
      { wch: 14 },
      { wch: 12 },
      { wch: 30 },
      { wch: 12 },
    ];

    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "환불참고");
    XLSX.writeFile(workbook, `환불참고_${format(new Date(), "yyyyMMdd_HHmmss")}.xlsx`);
    toast({ title: `${filteredRows.length}건을 엑셀로 내보냈습니다.` });
  };

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <RotateCcw className="w-6 h-6 text-primary" />
          <div>
            <h1 className="text-2xl font-bold" data-testid="text-page-title">환불관리</h1>
            <p className="mt-1 text-xs text-muted-foreground">계약관리에서 생성된 환불 음수계약만 조회하는 참고용 화면입니다.</p>
          </div>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          <span className="text-sm text-muted-foreground" data-testid="text-result-count">
            검색 결과 {filteredRows.length}건 | 총 환불금액 {formatAmount(totalRefundAmount)}원
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
            data-testid="button-excel-download"
          >
            <Download className="w-4 h-4" />
            엑셀다운
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
          value={sourceFilter}
          onValueChange={(value) => {
            setSourceFilter(value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-40 rounded-none" data-testid="filter-source">
            <SelectValue placeholder="기록구분" />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="all">전체</SelectItem>
            <SelectItem value="계약관리">계약관리</SelectItem>
          </SelectContent>
        </Select>
        <Select
          value={refundStatusFilter}
          onValueChange={(value) => {
            setRefundStatusFilter(value);
            setCurrentPage(1);
          }}
        >
          <SelectTrigger className="w-36 rounded-none" data-testid="filter-refund-status">
            <SelectValue placeholder="상태" />
          </SelectTrigger>
          <SelectContent className="rounded-none">
            <SelectItem value="all">전체</SelectItem>
            {uniqueStatuses.map((status) => (
              <SelectItem key={status} value={status}>{status}</SelectItem>
            ))}
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
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">구분</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">환불일</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">계약일</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">고객명</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">사용자ID</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">상품</th>
                  <th className="p-4 text-center font-medium text-xs whitespace-nowrap">일수</th>
                  <th className="p-4 text-center font-medium text-xs whitespace-nowrap">수량</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">기준금액</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">담당자</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">환불개수</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">환불일수</th>
                  <th className="p-4 text-right font-medium text-xs whitespace-nowrap">환불금액</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">상태</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">사유</th>
                  <th className="p-4 text-left font-medium text-xs whitespace-nowrap">처리자</th>
                </tr>
              </thead>
              <tbody>
                {isLoading ? (
                  Array.from({ length: 5 }).map((_, index) => (
                    <tr key={index} className="border-b border-border">
                      {Array.from({ length: 17 }).map((__, cellIndex) => (
                        <td key={cellIndex} className="p-4">
                          <Skeleton className="h-4 w-20" />
                        </td>
                      ))}
                    </tr>
                  ))
                ) : paginatedRows.length === 0 ? (
                  <tr>
                    <td colSpan={17} className="p-12 text-center text-muted-foreground">
                      조회할 환불 참고 데이터가 없습니다.
                    </td>
                  </tr>
                ) : (
                  paginatedRows.map((row) => (
                    <tr key={row.id} className="border-b border-border hover:bg-muted/20 transition-colors" data-testid={`refund-row-${row.id}`}>
                      <td className="p-4 text-xs whitespace-nowrap">{row.source}</td>
                      <td className="p-4 text-xs font-medium text-rose-600 whitespace-nowrap">{formatDate(row.refundDate)}</td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.contractDate ? formatDate(row.contractDate) : "-"}</td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.customerName}</td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.userIdentifier || "-"}</td>
                      <td className="p-4 text-xs text-muted-foreground max-w-[220px]">
                        <span className="truncate block">{row.products || "-"}</span>
                      </td>
                      <td className="p-4 text-xs text-center whitespace-nowrap">{row.days || 0}</td>
                      <td className="p-4 text-xs text-center whitespace-nowrap">{row.quantity || 0}</td>
                      <td className="p-4 text-xs font-medium text-right whitespace-nowrap">{formatAmount(row.targetAmount)}원</td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.managerName || "-"}</td>
                      <td className="p-4 text-xs text-right whitespace-nowrap">{row.quantity || 0}</td>
                      <td className="p-4 text-xs text-right whitespace-nowrap">{row.refundDays || 0}</td>
                      <td className="p-4 text-xs font-medium text-rose-600 text-right whitespace-nowrap">-{formatAmount(row.refundAmount)}원</td>
                      <td className="p-4 text-xs whitespace-nowrap">
                        <span className={getStatusClassName(row.refundStatus)}>{row.refundStatus}</span>
                      </td>
                      <td className="p-4 text-xs text-muted-foreground max-w-[240px]">
                        <span className="truncate block" title={row.reason || "-"}>
                          {row.reason || "-"}
                        </span>
                      </td>
                      <td className="p-4 text-xs whitespace-nowrap">{row.createdBy || "-"}</td>
                      <td className="p-4 text-right whitespace-nowrap">
                        <Button
                          variant="outline"
                          size="sm"
                          className="h-8 rounded-none text-xs"
                          onClick={() => handleWithdrawRefund(row)}
                          disabled={withdrawRefundMutation.isPending}
                          data-testid={`button-withdraw-refund-${row.id.replace(/[^a-zA-Z0-9_-]/g, "-")}`}
                        >
                          철회
                        </Button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
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
            <SelectItem value="20">20개씩 보기</SelectItem>
            <SelectItem value="50">50개씩 보기</SelectItem>
          </SelectContent>
        </Select>

        <Pagination currentPage={currentPage} totalPages={totalPages} onPageChange={setCurrentPage} />
      </div>
    </div>
  );
}
