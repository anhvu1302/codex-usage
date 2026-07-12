import { CalendarDays } from "lucide-react";
import { useMemo } from "react";
import type { DateRange as DayPickerRange } from "react-day-picker";

import { Button } from "@/web/components/ui/button";
import { Calendar } from "@/web/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { cn } from "@/web/lib/utils";
import type { DateRange } from "@/shared/types";

type DateRangePickerProps = {
  onChange: (range: DateRange) => void;
  value: DateRange;
};

export function DateRangePicker({ onChange, value }: DateRangePickerProps) {
  const selected = useMemo<DayPickerRange>(
    () => ({ from: parseDate(value.from), to: parseDate(value.to) }),
    [value.from, value.to],
  );

  function handleSelect(range: DayPickerRange | undefined) {
    if (!range?.from || !range.to) return;
    onChange({ from: formatDate(range.from), to: formatDate(range.to) });
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          className={cn("w-full justify-start text-left font-normal sm:w-[270px]")}
        >
          <CalendarDays className="size-4" />
          {value.from} — {value.to}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-auto p-0">
        <Calendar mode="range" numberOfMonths={2} onSelect={handleSelect} selected={selected} />
      </PopoverContent>
    </Popover>
  );
}

function parseDate(value: string): Date {
  return new Date(`${value}T12:00:00`);
}

function formatDate(value: Date): string {
  const values = Object.fromEntries(
    new Intl.DateTimeFormat("en-CA", {
      day: "2-digit",
      month: "2-digit",
      timeZone: "Asia/Ho_Chi_Minh",
      year: "numeric",
    })
      .formatToParts(value)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );
  return `${values["year"]}-${values["month"]}-${values["day"]}`;
}
