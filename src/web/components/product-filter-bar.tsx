import { Check, Filter, X } from "lucide-react";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { DateRangePicker } from "@/web/components/date-range-picker";
import { TagFilter } from "@/web/components/tag-filter";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import { Input } from "@/web/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/web/components/ui/select";
import { localDate, shiftDate } from "@/web/lib/product-api";
import { cn } from "@/web/lib/utils";
import type { AgentFilters, DashboardFilters } from "@/shared/types";

type ProjectOption = { id: string; name: string };

export function ProductFilterBar({
  filters,
  models,
  onChange,
  projects = [],
  showAgentDetails = false,
  showProject = false,
}: {
  filters: AgentFilters;
  models: string[];
  onChange: (filters: AgentFilters) => void;
  projects?: ProjectOption[];
  showAgentDetails?: boolean;
  showProject?: boolean;
}) {
  const activePresetRef = useRef<HTMLElement | null>(null);
  const presets = datePresets();
  const activePreset =
    presets.find((preset) => preset.range.from === filters.from && preset.range.to === filters.to)
      ?.id ?? "custom";
  const selectedModels = filters.models ?? (filters.model ? [filters.model] : []);
  const hasAdvanced =
    selectedModels.length > 0 ||
    Boolean(filters.projectId) ||
    Boolean(filters.tagIds?.length) ||
    (filters.agentKind !== undefined && filters.agentKind !== "all") ||
    Boolean(filters.role) ||
    filters.depth !== undefined;

  useEffect(() => {
    activePresetRef.current?.scrollIntoView({ block: "nearest", inline: "center" });
  }, [activePreset]);

  function toggleModel(model: string) {
    const models = selectedModels.includes(model)
      ? selectedModels.filter((value) => value !== model)
      : [...selectedModels, model];
    const base = withoutFilters(filters, "model", "models");
    onChange(models.length > 0 ? { ...base, models } : base);
  }

  return (
    <section
      aria-label="Bộ lọc dữ liệu"
      className="bg-background/92 sticky top-16 z-30 -mx-2 space-y-2 rounded-xl border p-2 shadow-sm backdrop-blur-xl lg:top-0"
    >
      <div className="flex flex-col gap-2 xl:flex-row xl:items-center xl:justify-between">
        <div
          className="flex snap-x snap-proximity scrollbar-none gap-1 overflow-x-auto [mask-image:linear-gradient(to_right,transparent,black_0.75rem,black_calc(100%-0.75rem),transparent)] px-2"
          aria-label="Khoảng thời gian"
        >
          {presets.map((preset) => (
            <Button
              key={preset.id}
              ref={
                activePreset === preset.id
                  ? (node) => {
                      activePresetRef.current = node;
                    }
                  : undefined
              }
              aria-pressed={activePreset === preset.id}
              className="shrink-0 snap-start"
              size="sm"
              variant={activePreset === preset.id ? "secondary" : "ghost"}
              onClick={() => onChange({ ...filters, ...preset.range })}
            >
              {preset.label}
            </Button>
          ))}
          <span
            ref={
              activePreset === "custom"
                ? (node) => {
                    activePresetRef.current = node;
                  }
                : undefined
            }
            className={cn(
              "shrink-0 snap-start",
              activePreset === "custom" && "ring-ring rounded-md ring-2",
            )}
          >
            <DateRangePicker
              value={filters}
              onChange={(range) => onChange({ ...filters, ...range })}
            />
          </span>
        </div>

        <div className="flex flex-wrap gap-2">
          <Popover>
            <PopoverTrigger asChild>
              <Button
                aria-label="Lọc theo model"
                className="max-w-full justify-start sm:max-w-64"
                size="sm"
                variant="outline"
              >
                <Filter className="size-4" />
                {selectedModels.length === 0
                  ? "Tất cả model"
                  : selectedModels.length === 1
                    ? selectedModels[0]
                    : `${selectedModels.length} model`}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-72 p-2">
              <p className="text-muted-foreground px-2 pb-2 text-xs font-medium">
                Có thể chọn nhiều model
              </p>
              <div className="max-h-64 space-y-1 overflow-y-auto">
                {models.map((model) => {
                  const active = selectedModels.includes(model);
                  return (
                    <button
                      key={model}
                      aria-pressed={active}
                      className="hover:bg-accent focus-visible:ring-ring flex w-full items-center justify-between rounded-md px-2 py-2 text-left text-sm outline-none focus-visible:ring-2"
                      type="button"
                      onClick={() => toggleModel(model)}
                    >
                      <span className="truncate">{model}</span>
                      {active ? <Check className="text-primary size-4" /> : null}
                    </button>
                  );
                })}
                {models.length === 0 ? (
                  <p className="text-muted-foreground p-3 text-center text-sm">Chưa có model.</p>
                ) : null}
              </div>
              {selectedModels.length > 0 ? (
                <Button
                  className="mt-2 w-full"
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    onChange(withoutFilters(filters, "model", "models"));
                  }}
                >
                  Bỏ chọn model
                </Button>
              ) : null}
            </PopoverContent>
          </Popover>

          <TagFilter
            tagIds={filters.tagIds}
            onChange={(tagIds) =>
              onChange(
                tagIds.length > 0 ? { ...filters, tagIds } : withoutFilters(filters, "tagIds"),
              )
            }
          />

          <Select
            value={filters.agentKind ?? "all"}
            onValueChange={(value) =>
              onChange({
                ...filters,
                agentKind: value as NonNullable<DashboardFilters["agentKind"]>,
              })
            }
          >
            <SelectTrigger aria-label="Lọc loại agent" className="h-8 w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">Mọi agent</SelectItem>
              <SelectItem value="main">Main agent</SelectItem>
              <SelectItem value="subagent">Subagent</SelectItem>
            </SelectContent>
          </Select>

          {showProject ? (
            <Select
              value={filters.projectId ?? "all"}
              onValueChange={(value) => {
                if (value === "all") {
                  onChange(withoutFilters(filters, "projectId"));
                } else onChange({ ...filters, projectId: value });
              }}
            >
              <SelectTrigger aria-label="Lọc project" className="h-8 w-48">
                <SelectValue placeholder="Mọi project" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="all">Mọi project</SelectItem>
                {projects.map((project) => (
                  <SelectItem key={project.id} value={project.id}>
                    {project.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          ) : null}
        </div>
      </div>

      {showAgentDetails ? (
        <div className="flex flex-wrap items-center gap-2 border-t pt-2">
          <DebouncedRoleInput
            key={filters.role ?? ""}
            initialRole={filters.role ?? ""}
            onCommit={(role) =>
              onChange(role ? { ...filters, role } : withoutFilters(filters, "role"))
            }
          />
          <Input
            aria-label="Lọc depth agent"
            className="h-8 w-32"
            max={100}
            min={0}
            placeholder="Depth"
            type="number"
            value={filters.depth ?? ""}
            onChange={(event) => {
              const value = event.target.value;
              if (value) onChange({ ...filters, depth: Number.parseInt(value, 10) });
              else onChange(withoutFilters(filters, "depth"));
            }}
          />
          {hasAdvanced ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={() =>
                onChange({
                  from: filters.from,
                  to: filters.to,
                })
              }
            >
              <X className="size-4" /> Xoá filter
            </Button>
          ) : null}
          <Badge className="ml-auto hidden sm:inline-flex" variant="outline">
            Cost là estimate
          </Badge>
        </div>
      ) : null}
    </section>
  );
}

function DebouncedRoleInput({
  initialRole,
  onCommit,
}: {
  initialRole: string;
  onCommit: (role: string) => void;
}) {
  const [draft, setDraft] = useState(initialRole);
  const commit = useEffectEvent(onCommit);
  useEffect(() => {
    const timer = window.setTimeout(() => {
      const role = draft.trim();
      if (role !== initialRole) commit(role);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [draft, initialRole]);
  return (
    <Input
      aria-label="Lọc role agent"
      className="h-8 w-44"
      maxLength={100}
      placeholder="Role, ví dụ Explorer"
      value={draft}
      onChange={(event) => setDraft(event.target.value)}
    />
  );
}

type OptionalFilterKey = "depth" | "model" | "models" | "projectId" | "role" | "tagIds";

function withoutFilters(filters: AgentFilters, ...keys: OptionalFilterKey[]): AgentFilters {
  const next = { ...filters };
  for (const key of keys) {
    switch (key) {
      case "depth":
        delete next.depth;
        break;
      case "model":
        delete next.model;
        break;
      case "models":
        delete next.models;
        break;
      case "projectId":
        delete next.projectId;
        break;
      case "role":
        delete next.role;
        break;
      case "tagIds":
        delete next.tagIds;
        break;
    }
  }
  return next;
}

function datePresets(): { id: string; label: string; range: DashboardFilters }[] {
  const today = localDate(new Date());
  return [
    { id: "today", label: "Hôm nay", range: { from: today, to: today } },
    { id: "7-days", label: "7 ngày", range: { from: shiftDate(today, -6), to: today } },
    { id: "30-days", label: "30 ngày", range: { from: shiftDate(today, -29), to: today } },
    { id: "month", label: "Tháng này", range: { from: `${today.slice(0, 8)}01`, to: today } },
    { id: "all", label: "Toàn bộ", range: { from: "2020-01-01", to: today } },
  ];
}
