import { ChevronLeft, ChevronRight } from "lucide-react";
import type { FC } from "react";
import { Button } from "@/web/components/ui/button";
import { cn } from "@/web/utils";

type PaginationProps = {
  currentPage: number;
  totalPages: number;
  onPageChange: (page: number) => void;
  className?: string;
};

export const Pagination: FC<PaginationProps> = ({
  currentPage,
  totalPages,
  onPageChange,
  className,
}) => {
  if (totalPages <= 1) return null;
  const slots = computeSlots(currentPage, totalPages);

  return (
    <div
      className={cn("flex items-center justify-center gap-1 py-3", className)}
      role="navigation"
      aria-label="Pagination"
    >
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        disabled={currentPage <= 1}
        onClick={() => onPageChange(currentPage - 1)}
        aria-label="Previous page"
      >
        <ChevronLeft className="h-4 w-4" />
      </Button>
      {slots.map((s, i) =>
        s === "ellipsis" ? (
          <span key={`ellipsis-${i}`} className="px-1 text-muted-foreground text-sm select-none">
            ...
          </span>
        ) : (
          <Button
            key={s}
            variant={s === currentPage ? "default" : "ghost"}
            size="sm"
            className={cn("h-8 w-8 p-0 text-xs", s === currentPage && "pointer-events-none")}
            onClick={() => onPageChange(s)}
            aria-current={s === currentPage ? "page" : undefined}
          >
            {s}
          </Button>
        ),
      )}
      <Button
        variant="ghost"
        size="sm"
        className="h-8 w-8 p-0"
        disabled={currentPage >= totalPages}
        onClick={() => onPageChange(currentPage + 1)}
        aria-label="Next page"
      >
        <ChevronRight className="h-4 w-4" />
      </Button>
      <span className="ml-3 text-xs text-muted-foreground whitespace-nowrap">
        {currentPage} / {totalPages}
      </span>
    </div>
  );
};

const computeSlots = (page: number, total: number): (number | "ellipsis")[] => {
  if (total <= 7) return Array.from({ length: total }, (_, i) => i + 1);
  const slots: (number | "ellipsis")[] = [1];
  const left = Math.max(2, page - 1);
  const right = Math.min(total - 1, page + 1);
  if (left > 2) slots.push("ellipsis");
  for (let i = left; i <= right; i++) slots.push(i);
  if (right < total - 1) slots.push("ellipsis");
  slots.push(total);
  return slots;
};
