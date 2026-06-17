import { useState } from "react";
import { Link, useLocation } from "wouter";
import { useAuth } from "@/lib/auth";
import { useSettings } from "@/lib/settings";
import {
  Sidebar,
  SidebarContent,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarMenuSub,
  SidebarMenuSubItem,
  SidebarMenuSubButton,
  SidebarHeader,
  SidebarFooter,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import {
  FileText,
  BarChart3,
  Settings,
  Bell,
  LogOut,
  ChevronDown,
  Calculator,
  Users,
} from "lucide-react";
import { usePermissions } from "@/lib/permissions";

type MenuChild = { title: string; url: string };
type MenuItem = {
  title: string;
  icon: React.ComponentType<{ className?: string }>;
  url?: string;
  children?: MenuChild[];
};

const menuItems: MenuItem[] = [
  {
    title: "\uD1B5\uACC4/\uBD84\uC11D",
    icon: BarChart3,
    children: [{ title: "\uB9E4\uCD9C\uBD84\uC11D", url: "/analytics/sales" }],
  },
  {
    title: "\uB9AC\uB4DC/\uACE0\uAC1D\uC0AC",
    icon: Users,
    children: [
      { title: "\uB9AC\uB4DC", url: "/leads" },
      { title: "\uACE0\uAC1D\uC0AC", url: "/customer-companies" },
    ],
  },
  {
    title: "\uACC4\uC57D/\uB9E4\uCD9C",
    icon: FileText,
    children: [
      { title: "\uACC4\uC57D\uAD00\uB9AC", url: "/contracts" },
      { title: "\uC0C1\uD488\uAD00\uB9AC", url: "/products" },
    ],
  },
  {
    title: "\uC7AC\uBB34/\uD68C\uACC4",
    icon: Calculator,
    children: [
      { title: "\uB9E4\uCD9C\uAD00\uB9AC", url: "/payments" },
      { title: "\uD658\uBD88\uAD00\uB9AC", url: "/refunds" },
      { title: "\uBBF8\uC218\uAE08\uAD00\uB9AC", url: "/receivables" },
      { title: "입금확인", url: "/deposit-confirmations" },
    ],
  },
  {
    title: "\uC124\uC815",
    icon: Settings,
    children: [
      { title: "\uC0AC\uC6A9\uC790\uAD00\uB9AC", url: "/settings/users" },
      { title: "\uC2DC\uC2A4\uD15C\uB85C\uADF8", url: "/settings/logs" },
      { title: "\uAD8C\uD55C\uC124\uC815", url: "/settings/permissions" },
      { title: "\uC2DC\uC2A4\uD15C\uC124\uC815", url: "/settings/system" },
    ],
  },
];

export function AppSidebar() {
  const [location] = useLocation();
  const [openMenus, setOpenMenus] = useState<string[]>([
    "\uD1B5\uACC4/\uBD84\uC11D",
    "\uACC4\uC57D/\uB9E4\uCD9C",
    "\uB9AC\uB4DC/\uACE0\uAC1D\uC0AC",
    "\uC7AC\uBB34/\uD68C\uACC4",
    "\uC124\uC815",
  ]);
  const { hasPathAccess } = usePermissions();
  const { logout, user } = useAuth();
  const { settings } = useSettings();
  const isDeveloper = user?.role === "\uAC1C\uBC1C\uC790";
  const companyName = settings.company_name || "EARTH LOOP MARKETING";

  const toggleMenu = (title: string) => {
    setOpenMenus((prev) => (prev.includes(title) ? prev.filter((t) => t !== title) : [...prev, title]));
  };

  const isChildActive = (children?: { url: string }[]) => {
    return children?.some((child) => location === child.url);
  };

  const dynamicMenuItems = menuItems.map((item) => {
    if (item.title === "\uC124\uC815" && isDeveloper && item.children) {
      return {
        ...item,
        children: [
          ...item.children,
          { title: "\uAD00\uB9AC\uC790", url: "/settings/admin" },
          { title: "\uBC31\uC5C5\uAD00\uB9AC", url: "/settings/backup" },
        ],
      };
    }
    return item;
  });

  const filteredMenuItems = dynamicMenuItems
    .map((item) => {
      if (item.url) {
        return hasPathAccess(item.url) ? item : null;
      }
      if (item.children) {
        const filteredChildren = item.children.filter((child) => hasPathAccess(child.url));
        if (filteredChildren.length === 0) return null;
        return { ...item, children: filteredChildren };
      }
      return item;
    })
    .filter(Boolean) as typeof menuItems;

  return (
    <Sidebar className="border-r border-border">
      <SidebarHeader className="p-5 border-b border-border">
        <div className="earthloop-brand flex items-center gap-3">
          <span className="earthloop-logo-shell" aria-hidden="true">
            <img src="/earthloop-logo.png" alt="" className="earthloop-logo-img" />
          </span>
          <div className="min-w-0">
            <h1 className="earthloop-wordmark leading-tight">EARTH LOOP</h1>
            <p className="earthloop-subtitle truncate" title={companyName}>MARKETING CRM</p>
          </div>
        </div>
      </SidebarHeader>

      <SidebarContent className="px-3 py-4">
        <SidebarMenu>
          {filteredMenuItems.map((item) => (
            <SidebarMenuItem key={item.title}>
              {item.children ? (
                <Collapsible open={openMenus.includes(item.title)} onOpenChange={() => toggleMenu(item.title)}>
                  <CollapsibleTrigger asChild>
                    <SidebarMenuButton
                      className={`h-10 px-4 w-full justify-between transition-all duration-200 ${
                        isChildActive(item.children) ? "font-semibold" : ""
                      }`}
                      data-testid={`menu-${item.title}`}
                    >
                      <div className="flex items-center gap-3">
                        <item.icon className="w-4 h-4" />
                        <span className="font-medium text-sm">{item.title}</span>
                      </div>
                      <ChevronDown
                        className={`w-4 h-4 transition-transform duration-200 ${
                          openMenus.includes(item.title) ? "rotate-180" : ""
                        }`}
                      />
                    </SidebarMenuButton>
                  </CollapsibleTrigger>
                  <CollapsibleContent>
                    <SidebarMenuSub className="ml-4 mt-1 border-l border-border pl-4">
                      {item.children.map((child) => (
                        <SidebarMenuSubItem key={child.title}>
                          <SidebarMenuSubButton
                            asChild
                            isActive={location === child.url}
                            className="h-9 px-3 transition-all duration-200"
                            data-testid={`menu-${child.url.replace("/", "").replace("/", "-")}`}
                          >
                            <Link href={child.url}>
                              <span className="text-sm">{child.title}</span>
                            </Link>
                          </SidebarMenuSubButton>
                        </SidebarMenuSubItem>
                      ))}
                    </SidebarMenuSub>
                  </CollapsibleContent>
                </Collapsible>
              ) : (
                <SidebarMenuButton
                  asChild
                  isActive={location === item.url}
                  data-testid={`menu-${item.url?.replace("/", "").replace("/", "-") || "item"}`}
                  className="h-10 px-4 transition-all duration-200"
                >
                  <Link href={item.url!} className="flex items-center gap-3">
                    <item.icon className="w-4 h-4" />
                    <span className="font-medium text-sm">{item.title}</span>
                  </Link>
                </SidebarMenuButton>
              )}
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarContent>

      <SidebarFooter className="p-3 border-t border-border mt-auto">
        <SidebarMenu className="space-y-1">
          {hasPathAccess("/notice") && (
          <SidebarMenuItem>
            <SidebarMenuButton asChild data-testid="menu-notice" className="h-10 px-4 transition-all duration-200">
              <Link href="/notice" className="flex items-center gap-3">
                <div className="relative">
                  <Bell className="w-4 h-4" />
                  <span className="absolute -top-1 -right-1 w-2 h-2 bg-red-500 rounded-full" />
                </div>
                <span className="font-medium text-sm">공지사항</span>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
          )}
          <SidebarMenuItem>
            <SidebarMenuButton
              data-testid="menu-logout"
              className="h-10 px-4 text-red-500 dark:text-red-400 transition-all duration-200"
              onClick={() => logout()}
            >
              <LogOut className="w-4 h-4" />
              <span className="font-medium text-sm">로그아웃</span>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}
