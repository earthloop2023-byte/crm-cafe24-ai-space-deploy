import { useState } from "react";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { Calendar as CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { CustomCalendar } from "@/components/custom-calendar";
import { getKoreanEndOfDay, getKoreanStartOfMonth, getKoreanStartOfYear, getKoreanToday } from "@/lib/korean-time";

type PeriodValue = "thisMonth" | "yesterday" | "today" | "lastWeek" | "lastMonth" | "lastYear" | "thisYear" | "custom";

type DatePeriodFilterProps = {
  startDate: Date;
  endDate: Date;
  onStartDateChange: (date: Date) => void;
  onEndDateChange: (date: Date) => void;
  onReset?: () => void;
  buttonClassName?: string;
  selectClassName?: string;
  buttonTestId?: string;
  selectTestId?: string;
};

function startOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(0, 0, 0, 0);
  return next;
}

function endOfDay(date: Date) {
  const next = new Date(date);
  next.setHours(23, 59, 59, 999);
  return next;
}

function addDays(date: Date, amount: number) {
  const next = new Date(date);
  next.setDate(next.getDate() + amount);
  return next;
}

function getWeekStart(date: Date) {
  const next = startOfDay(date);
  const day = next.getDay();
  next.setDate(next.getDate() + (day === 0 ? -6 : 1 - day));
  return next;
}

function getPeriodRange(period: PeriodValue) {
  const today = getKoreanToday();
  const year = today.getFullYear();
  const month = today.getMonth();

  if (period === "yesterday") {
    const target = addDays(today, -1);
    return { startDate: startOfDay(target), endDate: endOfDay(target) };
  }
  if (period === "today") {
    return { startDate: startOfDay(today), endDate: getKoreanEndOfDay() };
  }
  if (period === "lastWeek") {
    const start = addDays(getWeekStart(today), -7);
    return { startDate: start, endDate: endOfDay(addDays(start, 6)) };
  }
  if (period === "lastMonth") {
    return {
      startDate: new Date(year, month - 1, 1),
      endDate: endOfDay(new Date(year, month, 0)),
    };
  }
  if (period === "lastYear") {
    return {
      startDate: new Date(year - 1, 0, 1),
      endDate: endOfDay(new Date(year - 1, 11, 31)),
    };
  }
  if (period === "thisYear") {
    return {
      startDate: new Date(year, 0, 1),
      endDate: getKoreanEndOfDay(),
    };
  }

  return { startDate: getKoreanStartOfMonth(), endDate: getKoreanEndOfDay() };
}

export function DatePeriodFilter({
  startDate,
  endDate,
  onStartDateChange,
  onEndDateChange,
  onReset,
  buttonClassName = "w-full justify-start gap-2 rounded-none sm:w-56",
  selectClassName = "w-full rounded-none sm:w-32",
  buttonTestId = "filter-date",
  selectTestId = "filter-period",
}: DatePeriodFilterProps) {
  const [period, setPeriod] = useState<PeriodValue>("thisMonth");

  const applyRange = (nextPeriod: PeriodValue) => {
    const range = getPeriodRange(nextPeriod);
    setPeriod(nextPeriod);
    onStartDateChange(range.startDate);
    onEndDateChange(range.endDate);
  };

  return (
    <>
      <Popover>
        <PopoverTrigger asChild>
          <Button variant="outline" className={buttonClassName} data-testid={buttonTestId}>
            <CalendarIcon className="h-4 w-4 text-muted-foreground" />
            {format(startDate, "yyyy.MM.dd", { locale: ko })} ~ {format(endDate, "yyyy.MM.dd", { locale: ko })}
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-auto p-0 rounded-none bg-white" align="start">
          <CustomCalendar
            startDate={startDate}
            endDate={endDate}
            onSelectStart={(date) => {
              setPeriod("custom");
              onStartDateChange(date);
            }}
            onSelectEnd={(date) => {
              setPeriod("custom");
              onEndDateChange(date);
            }}
          />
        </PopoverContent>
      </Popover>
      <Select
        value={period}
        onValueChange={(value) => {
          if (value === "reset") {
            setPeriod("thisYear");
            if (onReset) {
              onReset();
              return;
            }
            onStartDateChange(getKoreanStartOfYear());
            onEndDateChange(getKoreanEndOfDay());
            return;
          }
          applyRange(value as PeriodValue);
        }}
      >
        <SelectTrigger className={selectClassName} data-testid={selectTestId}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent className="rounded-none">
          <SelectItem value="thisMonth">이번달</SelectItem>
          <SelectItem value="yesterday">어제</SelectItem>
          <SelectItem value="today">오늘</SelectItem>
          <SelectItem value="lastWeek">지난주</SelectItem>
          <SelectItem value="lastMonth">지난달</SelectItem>
          <SelectItem value="lastYear">작년</SelectItem>
          <SelectItem value="thisYear">올해</SelectItem>
        </SelectContent>
      </Select>
    </>
  );
}
