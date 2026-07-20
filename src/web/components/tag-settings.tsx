import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { LoaderCircle, Pencil, Tags, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";

import type { TagSummary, TagsResponse } from "@/shared/types";
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
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import { Skeleton } from "@/web/components/ui/skeleton";
import { queueLiveMutationScopes } from "@/web/lib/live-events";
import {
  createTag as createTagRequest,
  deleteTag as deleteTagRequest,
  fetchTags,
  renameTag as renameTagRequest,
} from "@/web/lib/product-api";

const TAG_MUTATION_SCOPES = [
  "activity",
  "agents",
  "catalog",
  "dashboard",
  "projects",
  "sessions",
  "turns",
] as const;

export function TagSettings() {
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [renaming, setRenaming] = useState<TagSummary | null>(null);
  const [deleting, setDeleting] = useState<TagSummary | null>(null);
  const tags = useQuery({
    queryKey: ["tags"],
    queryFn: ({ signal }) => fetchTags(signal),
    staleTime: 5 * 60_000,
  });
  const create = useMutation({
    mutationFn: createTagRequest,
    onError: (error) => toast.error(error.message),
    onSuccess: ({ tag }) => {
      setName("");
      queryClient.setQueryData<TagsResponse>(["tags"], (current) => ({
        tags: [...(current?.tags ?? []), { ...tag, projectCount: 0 }].sort((left, right) =>
          left.name.localeCompare(right.name, "en-US", { sensitivity: "base" }),
        ),
      }));
      queueLiveMutationScopes(queryClient, TAG_MUTATION_SCOPES);
      toast.success("Đã tạo tag.");
    },
  });
  const rename = useMutation({
    mutationFn: ({ id, nextName }: { id: string; nextName: string }) =>
      renameTagRequest(id, nextName),
    onError: (error) => toast.error(error.message),
    onSuccess: ({ tag }) => {
      setRenaming(null);
      queryClient.setQueryData<TagsResponse>(["tags"], (current) => ({
        tags: (current?.tags ?? []).map((item) =>
          item.id === tag.id ? { ...item, ...tag } : item,
        ),
      }));
      queueLiveMutationScopes(queryClient, TAG_MUTATION_SCOPES);
      toast.success("Đã đổi tên tag.");
    },
  });
  const remove = useMutation({
    mutationFn: deleteTagRequest,
    onError: (error) => toast.error(error.message),
    onSuccess: () => {
      const deletedId = deleting?.id;
      setDeleting(null);
      if (deletedId) {
        queryClient.setQueryData<TagsResponse>(["tags"], (current) => ({
          tags: (current?.tags ?? []).filter((tag) => tag.id !== deletedId),
        }));
      }
      queueLiveMutationScopes(queryClient, TAG_MUTATION_SCOPES);
      toast.success("Đã xoá tag và các gán liên quan.");
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    if (!name.trim()) return;
    create.mutate(name);
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Tags className="text-primary size-4" aria-hidden="true" />
          Quản lý tag project
        </CardTitle>
        <CardDescription>
          Tag dùng để nhóm và lọc project; tên được chuẩn hoá nhưng vẫn giữ kiểu chữ hiển thị.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5" aria-live="polite" aria-busy={tags.isLoading}>
        <form className="flex flex-col gap-2 sm:flex-row sm:items-end" onSubmit={submit}>
          <div className="flex-1 space-y-2">
            <Label htmlFor="new-tag-name">Tên tag mới</Label>
            <Input
              id="new-tag-name"
              maxLength={256}
              placeholder="Ví dụ: Production"
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <Button disabled={create.isPending || !name.trim()} type="submit">
            {create.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
            Tạo tag
          </Button>
        </form>

        {tags.isLoading ? (
          <div className="space-y-2">
            <Skeleton className="h-12" />
            <Skeleton className="h-12" />
          </div>
        ) : null}
        {tags.isError ? (
          <div
            className="border-destructive/40 space-y-3 rounded-lg border p-4 text-sm"
            role="alert"
          >
            <p>Không tải được tag: {tags.error.message}</p>
            <Button size="sm" variant="outline" onClick={() => void tags.refetch()}>
              Thử lại
            </Button>
          </div>
        ) : null}
        {tags.data?.tags.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border border-dashed p-6 text-center text-sm">
            Chưa có tag. Tạo tag đầu tiên để nhóm các project.
          </p>
        ) : null}
        {tags.data?.tags.length ? (
          <ul className="divide-y rounded-lg border" aria-label="Danh sách tag project">
            {tags.data.tags.map((tag) => (
              <li key={tag.id} className="flex flex-wrap items-center gap-3 p-3">
                <span className="min-w-0 flex-1 truncate font-medium">{tag.name}</span>
                <Badge variant="outline">{tag.projectCount} project</Badge>
                <Button
                  aria-label={`Đổi tên tag ${tag.name}`}
                  size="icon"
                  variant="ghost"
                  onClick={() => setRenaming(tag)}
                >
                  <Pencil className="size-4" />
                </Button>
                <Button
                  aria-label={`Xoá tag ${tag.name}`}
                  size="icon"
                  variant="ghost"
                  onClick={() => setDeleting(tag)}
                >
                  <Trash2 className="size-4" />
                </Button>
              </li>
            ))}
          </ul>
        ) : null}
      </CardContent>

      {renaming ? (
        <RenameTagDialog
          key={renaming.id}
          loading={rename.isPending}
          tag={renaming}
          onClose={() => setRenaming(null)}
          onSave={(nextName) => rename.mutate({ id: renaming.id, nextName })}
        />
      ) : null}
      <Dialog open={Boolean(deleting)} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xoá tag?</DialogTitle>
            <DialogDescription>
              Tag “{deleting?.name}” sẽ bị xoá khỏi {deleting?.projectCount ?? 0} project. Usage và
              project không bị xoá.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setDeleting(null)}>
              Huỷ
            </Button>
            <Button
              variant="destructive"
              disabled={remove.isPending || !deleting}
              onClick={() => deleting && remove.mutate(deleting.id)}
            >
              {remove.isPending ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Xoá tag
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </Card>
  );
}

function RenameTagDialog({
  loading,
  onClose,
  onSave,
  tag,
}: {
  loading: boolean;
  onClose: () => void;
  onSave: (name: string) => void;
  tag: TagSummary;
}) {
  const [name, setName] = useState(tag.name);
  return (
    <Dialog open onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Đổi tên tag</DialogTitle>
          <DialogDescription>
            Đổi tên hiển thị mà không thay đổi ID hay bộ lọc đã lưu.
          </DialogDescription>
        </DialogHeader>
        <form
          className="space-y-4"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) onSave(name);
          }}
        >
          <div className="space-y-2">
            <Label htmlFor="rename-tag-name">Tên tag</Label>
            <Input
              id="rename-tag-name"
              maxLength={256}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={onClose}>
              Huỷ
            </Button>
            <Button type="submit" disabled={loading || !name.trim()}>
              {loading ? <LoaderCircle className="size-4 animate-spin" /> : null}
              Lưu tên tag
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
