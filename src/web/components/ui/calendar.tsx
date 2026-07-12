import { ChevronLeft, ChevronRight } from "lucide-react";
import { DayPicker, type DayPickerProps } from "react-day-picker";

import { buttonVariants } from "@/web/components/ui/button";
import { cn } from "@/web/lib/utils";

function Calendar({ className, classNames, showOutsideDays = true, ...props }: DayPickerProps) {
  return (
    <DayPicker
      showOutsideDays={showOutsideDays}
      className={cn("p-3", className)}
      classNames={{
        button_next: cn(
          buttonVariants({ size: "icon", variant: "ghost" }),
          "size-7 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        button_previous: cn(
          buttonVariants({ size: "icon", variant: "ghost" }),
          "size-7 bg-transparent p-0 opacity-50 hover:opacity-100",
        ),
        caption_label: "text-sm font-medium",
        day: "size-8 p-0 text-center text-sm",
        day_button: cn(
          buttonVariants({ size: "icon", variant: "ghost" }),
          "size-8 rounded-md p-0 font-normal aria-selected:opacity-100",
        ),
        disabled: "text-muted-foreground opacity-50",
        hidden: "invisible",
        month: "space-y-4",
        month_caption: "flex h-7 items-center justify-center",
        months: "flex flex-col space-y-4 sm:flex-row sm:space-x-4 sm:space-y-0",
        nav: "flex items-center space-x-1",
        outside:
          "text-muted-foreground opacity-50 aria-selected:bg-accent/50 aria-selected:text-muted-foreground aria-selected:opacity-30",
        range_end: "day-range-end",
        range_middle: "aria-selected:bg-accent aria-selected:text-accent-foreground",
        range_start: "day-range-start",
        selected:
          "bg-primary text-primary-foreground hover:bg-primary hover:text-primary-foreground focus:bg-primary focus:text-primary-foreground",
        today: "bg-accent text-accent-foreground",
        week: "mt-2 flex w-full",
        weekday: "w-8 rounded-md text-[0.8rem] font-normal text-muted-foreground",
        week_number: "w-8 text-[0.8rem] text-muted-foreground",
        weeks: "mt-2",
        ...classNames,
      }}
      components={{
        Chevron: ({ orientation, ...componentProps }) =>
          orientation === "left" ? (
            <ChevronLeft className="size-4" {...componentProps} />
          ) : (
            <ChevronRight className="size-4" {...componentProps} />
          ),
      }}
      {...props}
    />
  );
}

export { Calendar };
