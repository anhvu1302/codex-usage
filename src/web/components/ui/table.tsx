import type {
  HTMLAttributes,
  TableHTMLAttributes,
  TdHTMLAttributes,
  ThHTMLAttributes,
} from "react";
import { forwardRef } from "react";

import { cn } from "@/web/lib/utils";

type TableProps = TableHTMLAttributes<HTMLTableElement> & { scrollLabel?: string };

const Table = forwardRef<HTMLTableElement, TableProps>(
  ({ className, scrollLabel = "Bảng dữ liệu có thể cuộn", ...props }, reference) => (
    <div
      aria-label={scrollLabel}
      className="relative w-full overflow-auto"
      role="region"
      // A focusable scroll container is required for keyboard access when the table overflows.
      // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex
      tabIndex={0}
    >
      <table
        ref={reference}
        className={cn("w-full caption-bottom text-sm", className)}
        {...props}
      />
    </div>
  ),
);
Table.displayName = "Table";

const TableHeader = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, reference) => (
    <thead ref={reference} className={cn("[&_tr]:border-b", className)} {...props} />
  ),
);
TableHeader.displayName = "TableHeader";

const TableBody = forwardRef<HTMLTableSectionElement, HTMLAttributes<HTMLTableSectionElement>>(
  ({ className, ...props }, reference) => (
    <tbody ref={reference} className={cn("[&_tr:last-child]:border-0", className)} {...props} />
  ),
);
TableBody.displayName = "TableBody";

const TableRow = forwardRef<HTMLTableRowElement, HTMLAttributes<HTMLTableRowElement>>(
  ({ className, ...props }, reference) => (
    <tr
      ref={reference}
      className={cn("hover:bg-muted/50 border-b transition-colors duration-200", className)}
      {...props}
    />
  ),
);
TableRow.displayName = "TableRow";

const TableHead = forwardRef<HTMLTableCellElement, ThHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, reference) => (
    <th
      ref={reference}
      className={cn(
        "text-muted-foreground h-10 px-3 text-left align-middle text-xs font-medium",
        className,
      )}
      {...props}
    />
  ),
);
TableHead.displayName = "TableHead";

const TableCell = forwardRef<HTMLTableCellElement, TdHTMLAttributes<HTMLTableCellElement>>(
  ({ className, ...props }, reference) => (
    <td ref={reference} className={cn("p-3 align-middle", className)} {...props} />
  ),
);
TableCell.displayName = "TableCell";

export { Table, TableBody, TableCell, TableHead, TableHeader, TableRow };
