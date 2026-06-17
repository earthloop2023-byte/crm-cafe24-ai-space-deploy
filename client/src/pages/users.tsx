import { useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { useForm } from "react-hook-form";
import { Search, Pencil, ArrowUpDown, Trash2 } from "lucide-react";

import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/components/ui/form";

import { Pagination } from "@/components/pagination";
import { queryClient, apiRequest } from "@/lib/queryClient";
import { useSettings } from "@/lib/settings";
import { useAuth } from "@/lib/auth";
import { usePermissions } from "@/lib/permissions";
import { useToast } from "@/hooks/use-toast";
import { positionOptions } from "@shared/schema";
import type { User } from "@shared/schema";

const EXECUTIVE_DEPARTMENT = "\uACBD\uC601\uC9C4";
const MANAGEMENT_ROLES = ["대표", "이사", "\uB300\uD45C\uC774\uC0AC", "\uCD1D\uAD04\uC774\uC0AC", "\uAC1C\uBC1C\uC790"];
const departmentOptions = ["경영진", "경영지원팀", "마케팅영업팀", "마케팅기획팀", "연구개발팀"];
const WORK_STATUS_EMPLOYED = "\uC7AC\uC9C1\uC911";
const WORK_STATUS_ON_LEAVE = "\uD734\uC9C1\uC911";
const WORK_STATUS_RESIGNED = "\uD1F4\uC0AC";
const workStatusOptions = [WORK_STATUS_EMPLOYED, WORK_STATUS_ON_LEAVE, WORK_STATUS_RESIGNED] as const;

type UserRoleLike = { role?: string | null; department?: string | null };

const isHiddenSystemAdmin = (user: User) =>
  user.loginId?.trim().toLowerCase() === "admin" || user.id === "__local_admin__";

const isExecutiveUser = (user?: UserRoleLike | null) =>
  !!user &&
  (MANAGEMENT_ROLES.includes(user.role || "") || String(user.department || "").trim() === EXECUTIVE_DEPARTMENT);

function createUserFormSchema(pwMinLength: number) {
  return z.object({
    loginId: z.string().min(1, "로그인ID를 입력하세요."),
    password: z
      .string()
      .min(pwMinLength, `비밀번호는 ${pwMinLength}자 이상이어야 합니다.`)
      .regex(/[A-Za-z]/, "영문을 포함해야 합니다.")
      .regex(/[0-9]/, "숫자를 포함해야 합니다.")
      .regex(/[!@#$%^&*(),.?\":{}|<>]/, "특수문자를 포함해야 합니다."),
    name: z.string().min(1, "사용자명을 입력하세요."),
    email: z.string().email("올바른 이메일 형식이 아닙니다.").optional().or(z.literal("")),
    phone: z.string().optional(),
    role: z.string().min(1, "권한을 선택하세요."),
    department: z.string().min(1, "부서를 선택하세요."),
    workStatus: z.string().min(1, "근무상태를 선택하세요."),
    isActive: z.boolean().default(true),
  });
}

function createUserEditFormSchema(pwMinLength: number) {
  return z.object({
    loginId: z.string().min(1, "로그인ID를 입력하세요."),
    password: z
      .string()
      .optional()
      .refine((val) => {
        if (!val || val === "") return true;
        if (val.length < pwMinLength) return false;
        if (!/[A-Za-z]/.test(val)) return false;
        if (!/[0-9]/.test(val)) return false;
        if (!/[!@#$%^&*(),.?\":{}|<>]/.test(val)) return false;
        return true;
      }, `비밀번호는 ${pwMinLength}자 이상, 영문+숫자+특수문자를 포함해야 합니다.`),
    name: z.string().min(1, "사용자명을 입력하세요."),
    email: z.string().email("올바른 이메일 형식이 아닙니다.").optional().or(z.literal("")),
    phone: z.string().optional(),
    role: z.string().min(1, "권한을 선택하세요."),
    department: z.string().min(1, "부서를 선택하세요."),
    workStatus: z.string().min(1, "근무상태를 선택하세요."),
    isActive: z.boolean().default(true),
  });
}

type UserFormData = z.infer<ReturnType<typeof createUserFormSchema>>;
type UserEditFormData = z.infer<ReturnType<typeof createUserEditFormSchema>>;

function parseErrorMessage(error: Error, fallback: string) {
  try {
    const bodyStart = error.message.indexOf("{");
    if (bodyStart >= 0) {
      const parsed = JSON.parse(error.message.slice(bodyStart));
      if (parsed?.error) return String(parsed.error);
    }
  } catch {
    // no-op
  }
  return fallback;
}

function normalizeWorkStatus(status?: string | null): string {
  const value = (status || "").trim();
  if (!value || value === "\uADFC\uBB34" || value === "\uADFC\uBB34\uC911" || value === "\uC7AC\uC9C1") {
    return WORK_STATUS_EMPLOYED;
  }
  if (value === "\uD734\uC9C1") {
    return WORK_STATUS_ON_LEAVE;
  }
  return value;
}

export default function Users() {
  const { toast } = useToast();
  const { user: currentUser } = useAuth();
  const { hasPageAccess } = usePermissions();
  const { formatDateTime, settings } = useSettings();
  const pwMinLength = parseInt(settings.password_min_length, 10) || 8;
  const canManageUsers = isExecutiveUser(currentUser);
  const canGrantPermissions = hasPageAccess("permissions");

  const [searchTerm, setSearchTerm] = useState("");
  const [pageSize, setPageSize] = useState("10");
  const [currentPage, setCurrentPage] = useState(1);
  const [selectedUsers, setSelectedUsers] = useState<string[]>([]);
  const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
  const [isEditDialogOpen, setIsEditDialogOpen] = useState(false);
  const [editingUser, setEditingUser] = useState<User | null>(null);

  const { data: users = [], isLoading } = useQuery<User[]>({
    queryKey: ["/api/users"],
  });

  const createForm = useForm<UserFormData>({
    resolver: zodResolver(createUserFormSchema(pwMinLength)),
    defaultValues: {
      loginId: "",
      password: "",
      name: "",
      email: "",
      phone: "",
      role: "",
      department: "",
      workStatus: WORK_STATUS_EMPLOYED,
      isActive: true,
    },
  });

  const editForm = useForm<UserEditFormData>({
    resolver: zodResolver(createUserEditFormSchema(pwMinLength)),
    defaultValues: {
      loginId: "",
      password: "",
      name: "",
      email: "",
      phone: "",
      role: "",
      department: "",
      workStatus: WORK_STATUS_EMPLOYED,
      isActive: true,
    },
  });

  const createMutation = useMutation({
    mutationFn: async (data: UserFormData) => apiRequest("POST", "/api/users", data),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "사용자가 등록되었습니다." });
      setIsCreateDialogOpen(false);
      createForm.reset();
    },
    onError: (error: Error) => {
      toast({
        title: parseErrorMessage(error, "사용자 등록에 실패했습니다."),
        variant: "destructive",
      });
    },
  });

  const updateMutation = useMutation({
    mutationFn: async (data: UserEditFormData & { id: string }) => {
      const { id, ...body } = data;
      const sendData: Record<string, unknown> = canManageUsers
        ? { ...body }
        : { password: body.password, email: body.email, phone: body.phone };
      if (!canGrantPermissions) delete sendData.role;
      if (!sendData.password) delete sendData.password;
      return apiRequest("PUT", `/api/users/${id}`, sendData);
    },
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      toast({ title: "사용자 정보가 수정되었습니다." });
      setIsEditDialogOpen(false);
      setEditingUser(null);
    },
    onError: (error: Error) => {
      toast({
        title: parseErrorMessage(error, "사용자 수정에 실패했습니다."),
        variant: "destructive",
      });
    },
  });

  const deleteMutation = useMutation({
    mutationFn: async (userIds: string[]) => {
      await Promise.all(userIds.map((id) => apiRequest("DELETE", `/api/users/${id}`)));
    },
    onSuccess: (_data, userIds) => {
      queryClient.invalidateQueries({ queryKey: ["/api/users"] });
      setSelectedUsers((prev) => prev.filter((id) => !userIds.includes(id)));
      if (editingUser && userIds.includes(editingUser.id)) {
        setEditingUser(null);
        setIsEditDialogOpen(false);
      }
      toast({ title: `${userIds.length}개 계정을 삭제했습니다.` });
    },
    onError: (error: Error) => {
      toast({
        title: parseErrorMessage(error, "계정 삭제에 실패했습니다."),
        variant: "destructive",
      });
    },
  });

  const requestDeleteUsers = (userIds: string[]) => {
    if (!canManageUsers) {
      toast({ title: "사용자 삭제는 경영진만 가능합니다.", variant: "destructive" });
      return;
    }
    const targets = userIds.filter((id) => id !== currentUser?.id);
    if (targets.length === 0) {
      toast({ title: "본인 계정은 삭제할 수 없습니다.", variant: "destructive" });
      return;
    }
    if (!window.confirm(`선택한 ${targets.length}개 계정을 삭제할까요?`)) return;
    deleteMutation.mutate(targets);
  };

  const filteredUsers = useMemo(
    () =>
      users.filter((user) => !isHiddenSystemAdmin(user)).filter((user) => {
        const q = searchTerm.trim().toLowerCase();
        if (!q) return true;
        return (
          user.loginId.toLowerCase().includes(q) ||
          user.name.toLowerCase().includes(q) ||
          (user.department?.toLowerCase().includes(q) ?? false) ||
          (user.role?.toLowerCase().includes(q) ?? false)
        );
      }),
    [users, searchTerm],
  );

  const pageSizeNumber = parseInt(pageSize, 10) || 10;
  const totalPages = Math.max(1, Math.ceil(filteredUsers.length / pageSizeNumber));
  const paginatedUsers = filteredUsers.slice(
    (currentPage - 1) * pageSizeNumber,
    currentPage * pageSizeNumber,
  );

  const toggleSelectAll = () => {
    if (selectedUsers.length === paginatedUsers.length) {
      setSelectedUsers([]);
      return;
    }
    setSelectedUsers(paginatedUsers.map((u) => u.id));
  };

  const toggleSelectUser = (userId: string) => {
    setSelectedUsers((prev) => (prev.includes(userId) ? prev.filter((id) => id !== userId) : [...prev, userId]));
  };

  const openEditDialog = (user: User) => {
    if (!canManageUsers && user.id !== currentUser?.id) {
      toast({ title: "다른 사용자 정보 수정은 경영진만 가능합니다.", variant: "destructive" });
      return;
    }
    setEditingUser(user);
    editForm.reset({
      loginId: user.loginId,
      password: "",
      name: user.name,
      email: user.email || "",
      phone: user.phone || "",
      role: user.role || "",
      department: user.department || "",
      workStatus: normalizeWorkStatus(user.workStatus),
      isActive: user.isActive ?? true,
    });
    setIsEditDialogOpen(true);
  };

  const columns = [
    { key: "loginId", label: "로그인ID" },
    { key: "name", label: "사용자명" },
    { key: "phone", label: "연락처" },
    { key: "role", label: "직책" },
    { key: "department", label: "부서" },
    { key: "workStatus", label: "근무상태" },
    { key: "lastLoginAt", label: "최종로그인" },
    { key: "lastPasswordChangeAt", label: "최종비밀번호변경" },
    { key: "actions", label: "" },
  ];

  const canEditSelectedUser = !!editingUser && (canManageUsers || editingUser.id === currentUser?.id);
  const canEditFullFields = !!editingUser && canManageUsers;
  const canEditContactFields = !!editingUser && (canManageUsers || editingUser.id === currentUser?.id);
  const canEditRoleField = canEditFullFields && canGrantPermissions;

  return (
    <div className="p-6">
      <div className="flex items-center justify-between mb-6 gap-3 flex-wrap">
        <h1 className="text-xl font-bold">사용자관리</h1>

        <div className="flex items-center gap-3">
          <span className="text-sm text-muted-foreground">검색 결과 {filteredUsers.length}건</span>

          <div className="relative">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-muted-foreground" />
            <Input
              placeholder="텍스트를 검색하세요"
              value={searchTerm}
              onChange={(e) => {
                setSearchTerm(e.target.value);
                setCurrentPage(1);
              }}
              className="pl-9 w-64 bg-card border-border rounded-none"
              data-testid="input-search"
            />
          </div>

          <Dialog open={isCreateDialogOpen} onOpenChange={setIsCreateDialogOpen}>
            <DialogTrigger asChild>
              <Button className="rounded-none" data-testid="button-register" disabled={!canManageUsers || !canGrantPermissions}>
                등록
              </Button>
            </DialogTrigger>
            <DialogContent className="rounded-none max-w-[920px] max-h-[85vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>사용자 등록</DialogTitle>
              </DialogHeader>
              <Form {...createForm}>
                <form
                  onSubmit={createForm.handleSubmit((data) => createMutation.mutate(data))}
                  className="grid grid-cols-1 md:grid-cols-2 gap-4"
                >
                  <FormField
                    control={createForm.control}
                    name="loginId"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>로그인ID</FormLabel>
                        <FormControl>
                          <Input {...field} className="rounded-none" data-testid="input-loginId" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="password"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>비밀번호</FormLabel>
                        <FormControl>
                          <Input type="password" {...field} className="rounded-none" data-testid="input-password" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="name"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>사용자명</FormLabel>
                        <FormControl>
                          <Input {...field} className="rounded-none" data-testid="input-name" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="email"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>이메일</FormLabel>
                        <FormControl>
                          <Input type="email" {...field} className="rounded-none" data-testid="input-email" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="phone"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>연락처</FormLabel>
                        <FormControl>
                          <Input {...field} className="rounded-none" data-testid="input-phone" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>직책</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value} disabled={!canGrantPermissions}>
                          <FormControl>
                            <SelectTrigger className="rounded-none" data-testid="select-role">
                              <SelectValue placeholder="직책 선택" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="rounded-none">
                            {positionOptions.map((option) => (
                              <SelectItem key={option} value={option}>
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="department"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>부서</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="rounded-none" data-testid="select-department">
                              <SelectValue placeholder="부서 선택" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="rounded-none">
                            {departmentOptions.map((option) => (
                              <SelectItem key={option} value={option}>
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={createForm.control}
                    name="workStatus"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>근무상태</FormLabel>
                        <Select onValueChange={field.onChange} value={field.value}>
                          <FormControl>
                            <SelectTrigger className="rounded-none" data-testid="select-workStatus">
                              <SelectValue placeholder="근무상태 선택" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent className="rounded-none">
                            {workStatusOptions.map((option) => (
                              <SelectItem key={option} value={option}>
                                {option}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <Button
                    type="submit"
                    className="w-full rounded-none md:col-span-2"
                    disabled={createMutation.isPending || !canManageUsers || !canGrantPermissions}
                  >
                    {createMutation.isPending ? "등록 중..." : "등록"}
                  </Button>
                </form>
              </Form>
            </DialogContent>
          </Dialog>
          <Button
            variant="destructive"
            className="rounded-none"
            disabled={selectedUsers.length === 0 || deleteMutation.isPending || !canManageUsers}
            onClick={() => requestDeleteUsers(selectedUsers)}
            data-testid="button-delete-selected-users"
          >
            {deleteMutation.isPending ? "삭제 중..." : "선택 삭제"}
          </Button>
        </div>
      </div>

      <Card className="rounded-none border-border p-4 mb-4 bg-muted/20">
        <div className="space-y-2 text-sm">
          <p className="font-semibold">직책 기반 기본 권한</p>
          <p><span className="font-semibold">대표/이사</span>: 시스템설정, 백업관리를 제외한 운영 전체 권한이 기본 적용됩니다.</p>
          <p><span className="font-semibold">실장/팀장</span>: 매출분석, 리드/고객사, 계약관리, 상품관리, 재무/회계 기본 권한이 적용됩니다.</p>
          <p><span className="font-semibold">매니저</span>: 매출관리/설정/상품관리는 숨기고, 매출분석은 본인 계약 기준으로 제한됩니다.</p>
          <p><span className="font-semibold">상담원</span>: 리드 등록과 리드 상담 중심으로 제한됩니다.</p>
          <p className="text-muted-foreground">직책은 기본 템플릿이며, 실제 메뉴 접근은 권한설정 화면에서 아이디별로 조정할 수 있습니다.</p>
        </div>
      </Card>

      <Card className="rounded-none border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="p-3 text-left w-12">
                  <Checkbox
                    checked={selectedUsers.length === paginatedUsers.length && paginatedUsers.length > 0}
                    onCheckedChange={toggleSelectAll}
                    disabled={!canManageUsers}
                    className="rounded-none"
                  />
                </th>
                {columns.map((col) => (
                  <th key={col.key} className="p-3 text-left text-sm font-medium text-muted-foreground whitespace-nowrap">
                    <span className="inline-flex items-center gap-1">
                      {col.label}
                      {col.label ? <ArrowUpDown className="w-3 h-3" /> : null}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {isLoading ? (
                <tr>
                  <td colSpan={columns.length + 1} className="p-8 text-center text-muted-foreground">
                    로딩 중...
                  </td>
                </tr>
              ) : paginatedUsers.length === 0 ? (
                <tr>
                  <td colSpan={columns.length + 1} className="p-8 text-center text-muted-foreground">
                    등록된 사용자가 없습니다.
                  </td>
                </tr>
              ) : (
                paginatedUsers.map((user) => (
                  <tr key={user.id} className="border-b border-border hover:bg-muted/20">
                    <td className="p-3">
                      <Checkbox
                        checked={selectedUsers.includes(user.id)}
                        onCheckedChange={() => toggleSelectUser(user.id)}
                        disabled={!canManageUsers}
                        className="rounded-none"
                      />
                    </td>
                    <td className="p-3 text-sm">{user.loginId}</td>
                    <td className="p-3 text-sm">{user.name}</td>
                    <td className="p-3 text-sm">{user.phone || "-"}</td>
                    <td className="p-3 text-sm">{user.role || "-"}</td>
                    <td className="p-3 text-sm">{user.department || "-"}</td>
                    <td className="p-3 text-sm">{normalizeWorkStatus(user.workStatus)}</td>
                    <td className="p-3 text-sm">{formatDateTime(user.lastLoginAt)}</td>
                    <td className="p-3 text-sm">{formatDateTime(user.lastPasswordChangeAt)}</td>
                    <td className="p-3 text-sm">
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" className="rounded-none" onClick={() => openEditDialog(user)}>
                          <Pencil className="w-4 h-4" />
                        </Button>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="rounded-none text-destructive hover:text-destructive"
                          disabled={deleteMutation.isPending || !canManageUsers}
                          onClick={() => requestDeleteUsers([user.id])}
                          data-testid={`button-delete-user-${user.id}`}
                        >
                          <Trash2 className="w-4 h-4" />
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))
              )}
            </tbody>
          </table>
        </div>

        <div className="flex items-center justify-between p-4 border-t border-border">
          <Select
            value={pageSize}
            onValueChange={(value) => {
              setPageSize(value);
              setCurrentPage(1);
            }}
          >
            <SelectTrigger className="w-32 rounded-none" data-testid="select-page-size">
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
      </Card>

      <Dialog open={isEditDialogOpen} onOpenChange={setIsEditDialogOpen}>
        <DialogContent className="rounded-none max-w-[920px] max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>사용자 수정</DialogTitle>
          </DialogHeader>
          <Form {...editForm}>
            <form
              onSubmit={editForm.handleSubmit((data) => {
                if (!editingUser) return;
                updateMutation.mutate({ ...data, id: editingUser.id });
              })}
              className="grid grid-cols-1 md:grid-cols-2 gap-4"
            >
              <FormField
                control={editForm.control}
                name="loginId"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>로그인ID</FormLabel>
                    <FormControl>
                      <Input {...field} className="rounded-none" disabled={!canEditFullFields} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="password"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>비밀번호(변경 시만 입력)</FormLabel>
                    <FormControl>
                      <Input type="password" {...field} className="rounded-none" disabled={!canEditContactFields} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="name"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>사용자명</FormLabel>
                    <FormControl>
                      <Input {...field} className="rounded-none" disabled={!canEditFullFields} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="email"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>이메일</FormLabel>
                    <FormControl>
                      <Input type="email" {...field} className="rounded-none" disabled={!canEditContactFields} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="phone"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>연락처</FormLabel>
                    <FormControl>
                      <Input {...field} className="rounded-none" disabled={!canEditContactFields} />
                    </FormControl>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="role"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>직책</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value} disabled={!canEditRoleField}>
                      <FormControl>
                        <SelectTrigger className="rounded-none">
                          <SelectValue placeholder="직책 선택" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-none">
                        {positionOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="department"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>부서</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value} disabled={!canEditFullFields}>
                      <FormControl>
                        <SelectTrigger className="rounded-none">
                          <SelectValue placeholder="부서 선택" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-none">
                        {departmentOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <FormField
                control={editForm.control}
                name="workStatus"
                render={({ field }) => (
                  <FormItem>
                    <FormLabel>근무상태</FormLabel>
                    <Select onValueChange={field.onChange} value={field.value} disabled={!canEditFullFields}>
                      <FormControl>
                        <SelectTrigger className="rounded-none">
                          <SelectValue placeholder="근무상태 선택" />
                        </SelectTrigger>
                      </FormControl>
                      <SelectContent className="rounded-none">
                        {workStatusOptions.map((option) => (
                          <SelectItem key={option} value={option}>
                            {option}
                          </SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <FormMessage />
                  </FormItem>
                )}
              />
              <Button
                type="submit"
                className="w-full rounded-none md:col-span-2"
                disabled={updateMutation.isPending || !canEditSelectedUser}
              >
                {updateMutation.isPending ? "수정 중..." : "수정"}
              </Button>
            </form>
          </Form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
