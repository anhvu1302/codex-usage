import { useQuery } from "@tanstack/react-query";
import { Check, Tags } from "lucide-react";

import { Button } from "@/web/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { fetchTags } from "@/web/lib/product-api";

export function TagFilter({
  onChange,
  tagIds = [],
}: {
  onChange: (tagIds: string[]) => void;
  tagIds?: string[] | undefined;
}) {
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => fetchTags(signal),
    staleTime: 5 * 60_000,
  });
  const selected = new Set(tagIds);
  const selectedNames = (tags.data?.tags ?? [])
    .filter((tag) => selected.has(tag.id))
    .map((tag) => tag.name);

  function toggle(tagId: string) {
    onChange(
      selected.has(tagId)
        ? tagIds.filter((value) => value !== tagId)
        : [...new Set([...tagIds, tagId])].slice(0, 50),
    );
  }

  return (
    <Popover>
      <PopoverTrigger asChild>
        <Button
          aria-label="Lọc theo tag"
          className="max-w-full justify-start sm:max-w-56"
          size="sm"
          variant="outline"
        >
          <Tags className="size-4" aria-hidden="true" />
          {tagIds.length === 0
            ? "Mọi tag"
            : tagIds.length === 1 && selectedNames[0]
              ? selectedNames[0]
              : `${tagIds.length} tag`}
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 p-2">
        <p className="text-muted-foreground px-2 pb-2 text-xs font-medium">
          Khớp bất kỳ tag đã chọn
        </p>
        <div className="max-h-64 space-y-1 overflow-y-auto">
          {tags.isLoading ? (
            <p className="text-muted-foreground p-3 text-center text-sm">Đang tải tag…</p>
          ) : null}
          {tags.isError ? (
            <div className="space-y-2 p-2 text-sm" role="alert">
              <p>Không tải được tag: {tags.error.message}</p>
              <Button size="sm" variant="outline" onClick={() => void tags.refetch()}>
                Thử lại
              </Button>
            </div>
          ) : null}
          {tags.data?.tags.map((tag) => {
            const active = selected.has(tag.id);
            return (
              <button
                key={tag.id}
                aria-pressed={active}
                className="hover:bg-accent focus-visible:ring-ring flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm outline-none focus-visible:ring-2"
                type="button"
                onClick={() => toggle(tag.id)}
              >
                <span className="min-w-0 truncate">
                  {tag.name}
                  <span className="text-muted-foreground ml-1 text-xs">({tag.projectCount})</span>
                </span>
                {active ? <Check className="text-primary size-4 shrink-0" /> : null}
              </button>
            );
          })}
          {tags.data?.tags.length === 0 ? (
            <p className="text-muted-foreground p-3 text-center text-sm">Chưa có tag.</p>
          ) : null}
        </div>
        {tagIds.length > 0 ? (
          <Button className="mt-2 w-full" size="sm" variant="ghost" onClick={() => onChange([])}>
            Bỏ chọn tag
          </Button>
        ) : null}
      </PopoverContent>
    </Popover>
  );
}
