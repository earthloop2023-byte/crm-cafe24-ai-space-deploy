import { useState } from "react";
import { useQuery, useMutation } from "@tanstack/react-query";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Skeleton } from "@/components/ui/skeleton";
import { Shield, Save, CheckSquare, Lock, RotateCcw } from "lucide-react";
import type { User, PagePermission } from "@shared/schema";
import { allPages, positionDefaultPages } from "@shared/schema";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/lib/auth";
import { usePermissions } from "@/lib/permissions";

const PERMISSION_ADMIN_ROLES = ["대표", "이사", "대표이사", "총괄이사", "개발자"];
const ADMIN_ONLY_PAGE_KEYS = new Set(["system_settings", "backup"]);

export default function PermissionsPage() {
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const { hasPageAccess } = usePermissions();
  const [localPermissions, setLocalPermissions] = useState<Record<string, string[]>>({});
  const [hasChanges, setHasChanges] = useState(false);

  const canEdit =
    !!currentUser &&
    (PERMISSION_ADMIN_ROLES.includes(currentUser.role || "") || hasPageAccess("permissions"));

  const { data: users = [], isLoading: usersLoading } = useQuery<User[]>({
    queryKey: ["/api/users"],
  });

  const { data: permissions = [], isLoading: permLoading } = useQuery<PagePermission[]>({
    queryKey: ["/api/permissions"],
  });
  const permissionPages = allPages.filter((page) => page.key !== "customers" && !ADMIN_ONLY_PAGE_KEYS.has(page.key));

  const activeUsers = users.filter(u => u.isActive && u.workStatus !== "퇴사");
  const permissionManagedUsers = activeUsers.filter((u) => u.role !== "개발자");

  const normalizePageKeys = (pageKeys: string[]) => {
    return Array.from(
      new Set(
        pageKeys
          .filter((pageKey) => !ADMIN_ONLY_PAGE_KEYS.has(pageKey))
          .flatMap((pageKey) => (pageKey === "dashboard" ? ["sales_analytics"] : [pageKey])),
      ),
    );
  };

  const getEffectivePageKeys = (user: User) => {
    const explicitPageKeys = normalizePageKeys(
      permissions.filter((permission) => permission.userId === user.id).map((permission) => permission.pageKey),
    );
    if (explicitPageKeys.length > 0) {
      return explicitPageKeys;
    }
    return normalizePageKeys(user.role ? positionDefaultPages[user.role] ?? [] : []);
  };

  const getPermissionsMap = (): Record<string, string[]> => {
    if (Object.keys(localPermissions).length > 0) return localPermissions;
    const map: Record<string, string[]> = {};
    permissionManagedUsers.forEach(u => {
      map[u.id] = getEffectivePageKeys(u);
    });
    return map;
  };

  const permMap = getPermissionsMap();

  const hasPermission = (userId: string, pageKey: string) => {
    return permMap[userId]?.includes(pageKey) ?? false;
  };

  const togglePermission = (userId: string, pageKey: string) => {
    if (!canEdit) return;
    const current = { ...permMap };
    if (!current[userId]) current[userId] = [];
    if (current[userId].includes(pageKey)) {
      current[userId] = current[userId].filter(k => k !== pageKey);
    } else {
      current[userId] = [...current[userId], pageKey];
    }
    setLocalPermissions(current);
    setHasChanges(true);
  };

  const toggleAllForUser = (userId: string) => {
    if (!canEdit) return;
    const current = { ...permMap };
    const allPageKeys = permissionPages.map(p => p.key);
    const allChecked = allPageKeys.every(key => current[userId]?.includes(key));
    if (allChecked) {
      current[userId] = [];
    } else {
      current[userId] = [...allPageKeys];
    }
    setLocalPermissions(current);
    setHasChanges(true);
  };

  const toggleAllForPage = (pageKey: string) => {
    if (!canEdit) return;
    const current = { ...permMap };
    const allChecked = permissionManagedUsers.every(u => current[u.id]?.includes(pageKey));
    permissionManagedUsers.forEach(u => {
      if (!current[u.id]) current[u.id] = [];
      if (allChecked) {
        current[u.id] = current[u.id].filter(k => k !== pageKey);
      } else {
        if (!current[u.id].includes(pageKey)) {
          current[u.id] = [...current[u.id], pageKey];
        }
      }
    });
    setLocalPermissions(current);
    setHasChanges(true);
  };

  const applyPositionDefaults = (userId: string) => {
    if (!canEdit) return;
    const user = permissionManagedUsers.find(u => u.id === userId);
    if (!user || !user.role) return;
    const defaults = positionDefaultPages[user.role];
    if (!defaults) {
      toast({ title: `${user.role} 직책의 기본 권한이 설정되어 있지 않습니다.`, variant: "destructive" });
      return;
    }
    const current = { ...permMap };
    current[userId] = normalizePageKeys(defaults);
    setLocalPermissions(current);
    setHasChanges(true);
    toast({ title: `${user.name}에게 ${user.role} 기본 권한을 적용했습니다.` });
  };

  const applyAllPositionDefaults = () => {
    if (!canEdit) return;
    const current = { ...permMap };
    let count = 0;
    permissionManagedUsers.forEach(u => {
      if (u.role && positionDefaultPages[u.role]) {
        current[u.id] = normalizePageKeys(positionDefaultPages[u.role]);
        count++;
      }
    });
    if (count > 0) {
      setLocalPermissions(current);
      setHasChanges(true);
      toast({ title: `${count}명의 사용자에게 직책별 기본 권한을 적용했습니다.` });
    } else {
      toast({ title: "적용할 직책별 기본 권한이 없습니다.", variant: "destructive" });
    }
  };

  const saveMutation = useMutation({
    mutationFn: async () => {
      const promises = Object.entries(permMap).map(([userId, pageKeys]) =>
        apiRequest("PUT", `/api/permissions/${userId}`, { pageKeys: normalizePageKeys(pageKeys) })
      );
      await Promise.all(promises);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ predicate: (query) => query.queryKey[0] === "/api/permissions" });
      setHasChanges(false);
      setLocalPermissions({});
      toast({ title: "권한이 저장되었습니다." });
    },
    onError: () => {
      toast({ title: "저장에 실패했습니다. 권한이 없습니다.", variant: "destructive" });
    },
  });

  const isLoading = usersLoading || permLoading;

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold">권한설정</h1>
        </div>
        <Card className="rounded-none border-border">
          <div className="p-6 space-y-4">
            {Array.from({ length: 5 }).map((_, i) => (
              <Skeleton key={i} className="h-10 w-full rounded-none" />
            ))}
          </div>
        </Card>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-3">
          <Shield className="w-6 h-6 text-primary" />
          <h1 className="text-2xl font-bold" data-testid="text-page-title">권한설정</h1>
        </div>
        <div className="flex items-center gap-3 flex-wrap">
          {!canEdit && (
            <div className="flex items-center gap-2 text-sm text-muted-foreground bg-muted/50 px-3 py-2" data-testid="text-readonly-notice">
              <Lock className="w-4 h-4" />
              <span>대표, 이사, 개발자 또는 권한설정 권한이 있는 계정만 수정 가능합니다</span>
            </div>
          )}
          {canEdit && (
            <>
              <Button
                variant="outline"
                className="rounded-none gap-2"
                onClick={applyAllPositionDefaults}
                data-testid="button-apply-all-defaults"
              >
                <RotateCcw className="w-4 h-4" />
                직책별 기본값 전체 적용
              </Button>
              <Button
                className="rounded-none gap-2"
                onClick={() => saveMutation.mutate()}
                disabled={!hasChanges || saveMutation.isPending}
                data-testid="button-save-permissions"
              >
                <Save className="w-4 h-4" />
                {saveMutation.isPending ? "저장 중..." : "저장"}
              </Button>
            </>
          )}
        </div>
      </div>

      {canEdit && (
        <div className="text-xs text-muted-foreground space-y-1">
          <p>직책별 기본 권한: 대표/이사(시스템설정, 백업관리 제외 전체) / 실장·팀장(조회 및 기본 운영) / 매니저(본인 계약 중심, 민감 재무 컬럼 숨김) / 상담원(리드 전용)</p>
          <p>개발자는 모든 페이지에 자동 접근 가능하므로 표에 표시되지 않습니다.</p>
        </div>
      )}

      <Card className="rounded-none border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full border-collapse">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-4 py-3 text-sm font-semibold text-muted-foreground sticky left-0 bg-muted/30 min-w-[180px] z-10">
                  페이지
                </th>
                {permissionManagedUsers.map((user) => (
                  <th key={user.id} className="px-3 py-3 text-center min-w-[100px]">
                    <div className="flex flex-col items-center gap-1">
                      <span className="text-sm font-semibold">{user.name}</span>
                      <span className="text-xs text-muted-foreground">{user.role || "-"}</span>
                      {canEdit && (
                        <div className="flex gap-1 mt-1">
                          <Button
                            variant="ghost"
                            size="sm"
                            className="rounded-none text-xs text-primary gap-1"
                            onClick={() => toggleAllForUser(user.id)}
                            data-testid={`button-toggle-all-user-${user.id}`}
                          >
                            <CheckSquare className="w-3 h-3" />
                            전체
                          </Button>
                          {user.role && positionDefaultPages[user.role] && (
                            <Button
                              variant="ghost"
                              size="sm"
                              className="rounded-none text-xs text-green-600 dark:text-green-400 gap-1"
                              onClick={() => applyPositionDefaults(user.id)}
                              data-testid={`button-dept-default-${user.id}`}
                            >
                              <RotateCcw className="w-3 h-3" />
                              기본값
                            </Button>
                          )}
                        </div>
                      )}
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {permissionPages.map((page) => (
                <tr key={page.key} className="border-b border-border last:border-b-0">
                  <td className="px-4 py-3 sticky left-0 bg-background z-10">
                    <div className="flex items-center justify-between">
                      <span className="text-sm font-medium" data-testid={`text-page-${page.key}`}>{page.label}</span>
                      {canEdit && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="rounded-none text-xs text-primary gap-1 ml-2"
                          onClick={() => toggleAllForPage(page.key)}
                          data-testid={`button-toggle-all-page-${page.key}`}
                        >
                          <CheckSquare className="w-3 h-3" />
                        </Button>
                      )}
                    </div>
                  </td>
                  {permissionManagedUsers.map((user) => (
                    <td key={user.id} className="px-3 py-3 text-center">
                      <div className="flex items-center justify-center">
                        <Checkbox
                          checked={hasPermission(user.id, page.key)}
                          onCheckedChange={() => togglePermission(user.id, page.key)}
                          className="rounded-none"
                          disabled={!canEdit}
                          data-testid={`checkbox-permission-${user.id}-${page.key}`}
                        />
                      </div>
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}
