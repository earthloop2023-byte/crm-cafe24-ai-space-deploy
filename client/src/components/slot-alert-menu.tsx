import { useEffect, useMemo, useRef } from "react";
import { Bell, CalendarClock, ExternalLink, Trash2 } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";

type RenewalAlert = {
  id: string;
  contractNumber: string;
  customerName: string;
  products?: string | null;
  renewalDueDate: string;
  renewalAlertDisabled: boolean;
};

function formatDate(value: string | Date | null | undefined) {
  if (!value) return "-";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "-";
  return date.toLocaleDateString("ko-KR", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });
}

export function RenewalAlertMenu() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const notifiedKeyRef = useRef("");

  const { data: alerts = [], isLoading } = useQuery<RenewalAlert[]>({
    queryKey: ["/api/renewal-alerts"],
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: true,
  });

  const alertKey = useMemo(() => alerts.map((alert) => alert.id).join(","), [alerts]);

  useEffect(() => {
    if (!alerts.length || !alertKey || notifiedKeyRef.current === alertKey) return;
    notifiedKeyRef.current = alertKey;
    toast({
      title: `계약연장 알림 ${alerts.length}건`,
      description: "우측 상단 알림창에서 금일 만료되는 계약을 확인해주세요.",
    });
  }, [alertKey, alerts.length, toast]);

  const deleteMutation = useMutation({
    mutationFn: (id: string) => apiRequest("POST", `/api/renewal-alerts/${id}/disable`),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/renewal-alerts"] });
      queryClient.invalidateQueries({ queryKey: ["/api/contracts/paged"] });
      toast({ title: "계약연장 알림을 해제했습니다." });
    },
    onError: (error: Error) => {
      toast({ title: error.message || "알림 해제에 실패했습니다.", variant: "destructive" });
    },
  });

  const openContracts = (alert: RenewalAlert) => {
    const params = new URLSearchParams();
    params.set("contractNumber", alert.contractNumber);
    window.location.assign(`/contracts?${params.toString()}`);
  };

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="ghost"
          size="icon"
          className="relative h-9 w-9 rounded-none border border-border bg-muted/30"
          data-testid="button-renewal-alerts"
        >
          <Bell className="h-5 w-5 text-muted-foreground" />
          {alerts.length > 0 && (
            <span className="absolute -right-1 -top-1 flex h-5 min-w-5 items-center justify-center rounded-full bg-red-600 px-1 text-[10px] font-semibold text-white">
              {alerts.length > 99 ? "99+" : alerts.length}
            </span>
          )}
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96 rounded-none p-0" align="end">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div>
            <p className="text-sm font-semibold">계약연장 알림</p>
            <p className="text-xs text-muted-foreground">금일 만료되는 계약 기준</p>
          </div>
          <Badge variant={alerts.length ? "destructive" : "secondary"} className="rounded-none">
            {alerts.length}건
          </Badge>
        </div>

        <div className="max-h-96 overflow-auto">
          {isLoading ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">알림을 불러오는 중입니다.</div>
          ) : alerts.length === 0 ? (
            <div className="px-4 py-6 text-sm text-muted-foreground">현재 확인할 계약연장 알림이 없습니다.</div>
          ) : (
            <div className="divide-y divide-border">
              {alerts.map((alert) => (
                <div key={alert.id} className="space-y-3 px-4 py-3">
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{alert.customerName}</p>
                      <p className="truncate text-xs text-muted-foreground">
                        {alert.contractNumber} · {alert.products || "상품 미지정"}
                      </p>
                    </div>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0 rounded-none text-muted-foreground hover:text-destructive"
                      onClick={() => deleteMutation.mutate(alert.id)}
                      disabled={deleteMutation.isPending}
                      data-testid={`button-disable-renewal-alert-${alert.id}`}
                    >
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </div>
                  <div className="flex items-center justify-between gap-3 text-xs">
                    <span className="inline-flex items-center gap-1 text-red-600">
                      <CalendarClock className="h-3.5 w-3.5" />
                      예정 {formatDate(alert.renewalDueDate)}
                    </span>
                    <Button
                      variant="outline"
                      size="sm"
                      className="h-7 rounded-none px-2 text-xs"
                      onClick={() => openContracts(alert)}
                      data-testid={`button-open-renewal-contract-${alert.id}`}
                    >
                      <ExternalLink className="mr-1 h-3.5 w-3.5" />
                      계약관리
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
