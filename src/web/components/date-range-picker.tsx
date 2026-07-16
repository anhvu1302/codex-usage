import { CalendarDays } from "lucide-react";
import { lazy, Suspense, useMemo, useState } from "react";
import type { DateRange as DayPickerRange } from "react-day-picker";

import { Button } from "@/web/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { cn } from "@/web/lib/utils";
import type { DateRange } from "@/shared/types";

type DateRangePickerProps = {
  onChange: (range: DateRange) => void;
  value: DateRange;
};
const LOCAL_DATE_FORMATTER = new Intl.DateTimeFormat("en-CA", {
  day: "2-digit",
  month: "2-digit",
  timeZone: "Asia/Ho_Chi_Minh",
  year: "numeric",
});
const Calendar = lazy(async () => ({
  default: (await import("@/web/components/ui/calendar")).Calendar,
}));

export function DateRangePicker({ onChange, value }: DateRangePickerProps) {
  const [open, setOpen] = useState(false);
  const selected = useMemo<DayPickerRange>(
    () => ({ from: parseDate(value.from), to: parseDate(value.to) }),
    [value.from, value.to],
  );

  function handleSelect(range: DayPickerRange | undefined) {
    if (!range?.from || !range.to) return;
    onChange({ from: formatDate(range.from), to: formatDate(range.to) });
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          aria-label={`Tuỳ chọn ngày, từ ${value.from} đến ${value.to}`}
          variant="outline"
          className={cn("w-[260px] justify-start text-left font-normal")}
        >
          <CalendarDays className="size-4" />
          {value.from} — {value.to}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        {open ? (
          <Suspense fallback={<div className="bg-muted h-80 w-72 animate-pulse rounded-md" />}>
            <Calendar mode="range" numberOfMonths={1} onSelect={handleSelect} selected={selected} />
          </Suspense>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}

function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function formatDate(value: Date): string {
  const values = Object.fromEntries(
    LOCAL_DATE_FORMATTER.formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}
