import { zodResolver } from "@hookform/resolvers/zod";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, HardDrive, Pencil, RefreshCw, WandSparkles } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useForm } from "react-hook-form";
import { toast } from "sonner";
import { z } from "zod";

import {
  backfillRate,
  compactStorage,
  fetchModels,
  fetchRates,
  fetchStorageStatus,
  saveRate,
} from "@/web/lib/api";
import { Badge } from "@/web/components/ui/badge";
import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/web/components/ui/dialog";
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@/web/components/ui/form";
import { Input } from "@/web/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/web/components/ui/table";
import type { ModelRate } from "@/shared/types";

const rateSchema = z.object({
  cachedInputRate: z.number().finite().nonnegative(),
  inputRate: z.number().finite().nonnegative(),
  outputRate: z.number().finite().nonnegative(),
});

type RateValues = z.infer<typeof rateSchema>;

export function RateSettings() {
  const [editing, setEditing] = useState<{ model: string; rate: ModelRate | null } | null>(null);
  const queryClient = useQueryClient();
  const models = useQuery({ queryKey: ["models"], queryFn: fetchModels });
  const rates = useQuery({ queryKey: ["rates"], queryFn: fetchRates });
  const backfill = useMutation({
    mutationFn: backfillRate,
    onError: (error) => toast.error(error.message),
    onSuccess: (result) => {
      toast.success(`Đã áp giá cho ${result.updated} usage chưa định giá.`);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  const rateByModel = useMemo(
    () => new Map((rates.data?.rates ?? []).map((rate) => [rate.model, rate])),
    [rates.data?.rates],
  );
  const allModels = useMemo(
    () => [...new Set([...(models.data?.models ?? []), ...rateByModel.keys()])].sort(),
    [models.data?.models, rateByModel],
  );

  return (
    <div className="motion-stagger space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Rate cards</CardTitle>
          <CardDescription>
            Giá USD trên 1 triệu token. Usage giữ price snapshot lúc import; Backfill chỉ cập nhật
            record chưa có cost.
          </CardDescription>
        </CardHeader>
        <CardContent className="p-0">
          <Table className="motion-table">
            <TableHeader>
              <TableRow>
                <TableHead>Model</TableHead>
                <TableHead>Input</TableHead>
                <TableHead>Cached input</TableHead>
                <TableHead>Output</TableHead>
                <TableHead>Updated</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {allModels.map((model) => {
                const rate = rateByModel.get(model) ?? null;
                return (
                  <TableRow key={model}>
                    <TableCell className="font-medium">{model}</TableCell>
                    <TableCell>
                      {rate ? (
                        usdRate(rate.inputRate)
                      ) : (
                        <Badge variant="secondary">Chưa có giá</Badge>
                      )}
                    </TableCell>
                    <TableCell>{rate ? usdRate(rate.cachedInputRate) : "—"}</TableCell>
                    <TableCell>{rate ? usdRate(rate.outputRate) : "—"}</TableCell>
                    <TableCell>{rate ? formatDate(rate.updatedAt) : "—"}</TableCell>
                    <TableCell>
                      <div className="flex justify-end gap-2">
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => setEditing({ model, rate })}
                        >
                          <Pencil className="size-3.5" />
                          Edit
                        </Button>
                        {rate ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            onClick={() => backfill.mutate(model)}
                            disabled={backfill.isPending}
                          >
                            <WandSparkles className="size-3.5" />
                            Backfill
                          </Button>
                        ) : null}
                      </div>
                    </TableCell>
                  </TableRow>
                );
              })}
              {!models.isLoading && allModels.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-muted-foreground h-24 text-center">
                    Sync sessions trước để phát hiện model cần định giá.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </CardContent>
        <RateDialog editing={editing} onOpenChange={(open) => !open && setEditing(null)} />
      </Card>
      <StorageSettings />
    </div>
  );
}

function StorageSettings() {
  const queryClient = useQueryClient();
  const storage = useQuery({
    queryKey: ["storage"],
    queryFn: fetchStorageStatus,
    refetchInterval: 30_000,
  });
  const compact = useMutation({
    mutationFn: compactStorage,
    onError: (error) => toast.error(error.message),
    onSuccess: (result) => {
      toast.success(
        `Đã compact ${result.lastRawEventsDeleted} raw event và dọn ${result.lastHourlyRowsDeleted} hourly row.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
      void queryClient.invalidateQueries({ queryKey: ["storage"] });
    },
  });
  const data = storage.data;

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-4">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Archive className="size-4" /> Storage retention
          </CardTitle>
          <CardDescription className="mt-1">
            Raw 30 ngày, hourly 90 ngày, daily theo model và main/subagent được giữ vĩnh viễn.
          </CardDescription>
        </div>
        <Button
          variant="outline"
          onClick={() => compact.mutate()}
          disabled={compact.isPending || data?.isCompacting}
        >
          <RefreshCw
            className={compact.isPending || data?.isCompacting ? "size-4 animate-spin" : "size-4"}
          />
          Compact now
        </Button>
      </CardHeader>
      <CardContent className="space-y-4">
        {data?.error ? <p className="text-destructive text-sm">{data.error}</p> : null}
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <StorageMetric label="SQLite" value={formatBytes(data?.databaseBytes ?? 0)} />
          <StorageMetric label="WAL" value={formatBytes(data?.walBytes ?? 0)} />
          <StorageMetric label="Raw events" value={formatInteger(data?.rawEvents ?? 0)} />
          <StorageMetric
            label="Hourly / daily rows"
            value={`${formatInteger(data?.hourlyRows ?? 0)} / ${formatInteger(data?.dailyRows ?? 0)}`}
          />
        </div>
        <div className="flex flex-col justify-between gap-3 rounded-lg border p-4 sm:flex-row sm:items-center">
          <div className="flex items-start gap-3">
            <HardDrive className="text-muted-foreground mt-0.5 size-4" />
            <div>
              <p className="text-sm font-medium">Codex JSONL source</p>
              <p className="text-muted-foreground mt-1 text-xs">
                {formatBytes(data?.sourceBytes ?? 0)} · chỉ đọc, app không nén, di chuyển hoặc xóa.
              </p>
            </div>
          </div>
          <div className="text-muted-foreground text-xs sm:text-right">
            <p>Compact gần nhất: {formatOptionalDate(data?.lastCompactionAt)}</p>
            <p>
              Raw cũ nhất: {data?.oldestRawDate ?? "—"} · Hourly: {data?.oldestHourlyDate ?? "—"}
            </p>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function StorageMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="bg-muted rounded-lg p-3">
      <p className="text-muted-foreground text-xs">{label}</p>
      <p className="mt-1 font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function RateDialog({
  editing,
  onOpenChange,
}: {
  editing: { model: string; rate: ModelRate | null } | null;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const form = useForm<RateValues>({
    defaultValues: defaults(editing?.rate),
    mode: "onChange",
    resolver: zodResolver(rateSchema),
  });
  const save = useMutation({
    mutationFn: saveRate,
    onError: (error) => toast.error(error.message),
    onSuccess: (result) => {
      toast.success(
        result.backfilled > 0
          ? `Đã lưu rate card và định giá ${result.backfilled} usage cũ.`
          : "Đã lưu rate card. Usage mới sẽ dùng giá này.",
      );
      onOpenChange(false);
      void queryClient.invalidateQueries({ queryKey: ["dashboard"] });
      void queryClient.invalidateQueries({ queryKey: ["rates"] });
      void queryClient.invalidateQueries({ queryKey: ["sessions"] });
    },
  });

  useEffect(() => form.reset(defaults(editing?.rate)), [editing?.model, editing?.rate, form]);

  function onSubmit(values: RateValues) {
    if (!editing) return;
    save.mutate({ model: editing.model, ...values });
  }

  return (
    <Dialog open={Boolean(editing)} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rate card: {editing?.model}</DialogTitle>
          <DialogDescription>
            Nhập USD / 1M token. Tất cả giá phải là số không âm.
          </DialogDescription>
        </DialogHeader>
        <Form {...form}>
          <form
            className="space-y-4"
            onSubmit={(event) => {
              void form.handleSubmit(onSubmit)(event);
            }}
          >
            <RateInput control={form.control} label="Uncached input" name="inputRate" />
            <RateInput control={form.control} label="Cached input" name="cachedInputRate" />
            <RateInput control={form.control} label="Output" name="outputRate" />
            <DialogFooter>
              <Button type="submit" disabled={!form.formState.isValid || save.isPending}>
                {save.isPending ? <RefreshCw className="size-4 animate-spin" /> : null} Save rate
                card
              </Button>
            </DialogFooter>
          </form>
        </Form>
      </DialogContent>
    </Dialog>
  );
}

function RateInput({
  control,
  label,
  name,
}: {
  control: ReturnType<typeof useForm<RateValues>>["control"];
  label: string;
  name: keyof RateValues;
}) {
  return (
    <FormField
      control={control}
      name={name}
      render={({ field }) => (
        <FormItem>
          <FormLabel>{label}</FormLabel>
          <FormControl>
            <Input
              type="number"
              min="0"
              step="0.0001"
              {...field}
              value={field.value}
              onChange={(event) => field.onChange(event.target.valueAsNumber)}
            />
          </FormControl>
          <FormMessage />
        </FormItem>
      )}
    />
  );
}

function defaults(rate: ModelRate | null | undefined): RateValues {
  return {
    cachedInputRate: rate?.cachedInputRate ?? 0,
    inputRate: rate?.inputRate ?? 0,
    outputRate: rate?.outputRate ?? 0,
  };
}

function usdRate(value: number) {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: "USD",
    maximumFractionDigits: 4,
  }).format(value);
}
function formatDate(value: string) {
  return new Intl.DateTimeFormat("vi-VN", { dateStyle: "medium", timeStyle: "short" }).format(
    new Date(value),
  );
}

function formatOptionalDate(value: string | null | undefined) {
  return value ? formatDate(value) : "Chưa chạy";
}

function formatBytes(value: number) {
  if (value < 1024) return `${value} B`;
  const units = ["MB", "GB", "TB"];
  let size = value / 1024;
  let unit = "KB";
  for (const nextUnit of units) {
    if (size < 1024) break;
    size /= 1024;
    unit = nextUnit;
  }
  return `${size.toFixed(size >= 100 ? 0 : 1)} ${unit}`;
}

function formatInteger(value: number) {
  return new Intl.NumberFormat("en-US", { maximumFractionDigits: 0 }).format(value);
}
