import { Bookmark, BookmarkPlus, Pencil, Trash2 } from "lucide-react";
import { useState, type FormEvent } from "react";
import { useLocation, useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "@/web/components/ui/button";
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
import { Popover, PopoverContent, PopoverTrigger } from "@/web/components/ui/popover";
import { savedViewPath, useSavedViews, type SavedView } from "@/web/lib/saved-views";

export function SavedViewsControls() {
  const location = useLocation();
  const navigate = useNavigate();
  const { add, remove, rename, views } = useSavedViews();
  const [menuOpen, setMenuOpen] = useState(false);
  const [saveOpen, setSaveOpen] = useState(false);
  const [name, setName] = useState("");
  const [editing, setEditing] = useState<SavedView | null>(null);
  const [deleting, setDeleting] = useState<SavedView | null>(null);
  const eligible = savedViewPath(location.pathname) !== null;

  function save(event: FormEvent) {
    event.preventDefault();
    const result = add(name, location.pathname, location.search);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setName("");
    setSaveOpen(false);
    toast.success("Đã lưu view hiện tại.");
  }

  function commitRename(event: FormEvent) {
    event.preventDefault();
    if (!editing) return;
    const result = rename(editing.id, name);
    if (!result.ok) {
      toast.error(result.error);
      return;
    }
    setEditing(null);
    setName("");
    toast.success("Đã đổi tên Saved View.");
  }

  return (
    <div className="flex items-center gap-1">
      {eligible ? (
        <Button
          aria-label="Lưu view hiện tại"
          size="icon"
          type="button"
          variant="ghost"
          onClick={() => {
            setName("");
            setSaveOpen(true);
          }}
        >
          <BookmarkPlus className="size-4" aria-hidden="true" />
        </Button>
      ) : null}

      <Popover open={menuOpen} onOpenChange={setMenuOpen}>
        <PopoverTrigger asChild>
          <Button
            aria-label={views.length > 0 ? `Saved Views: ${views.length}` : "Saved Views"}
            size="icon"
            type="button"
            variant="ghost"
          >
            <Bookmark className="size-4" aria-hidden="true" />
          </Button>
        </PopoverTrigger>
        <PopoverContent align="end" className="w-80 p-2">
          <div className="flex items-center justify-between gap-3 px-2 py-1.5">
            <div>
              <p className="text-sm font-semibold">Saved Views</p>
              <p className="text-muted-foreground text-xs">Bộ lọc được lưu trong trình duyệt.</p>
            </div>
            <span className="text-muted-foreground text-xs tabular-nums">{views.length}/20</span>
          </div>
          <div className="mt-1 max-h-80 space-y-1 overflow-y-auto">
            {views.map((view) => (
              <div key={view.id} className="hover:bg-accent group flex items-center rounded-md p-1">
                <button
                  className="focus-visible:ring-ring min-w-0 flex-1 rounded px-2 py-2 text-left outline-none focus-visible:ring-2"
                  type="button"
                  onClick={() => {
                    setMenuOpen(false);
                    void navigate({
                      pathname: view.pathname,
                      search: view.search ? `?${view.search}` : "",
                    });
                  }}
                >
                  <span className="block truncate text-sm font-medium">{view.name}</span>
                  <span className="text-muted-foreground block truncate text-xs">
                    {view.pathname}
                    {view.search ? `?${view.search}` : ""}
                  </span>
                </button>
                <Button
                  aria-label={`Đổi tên ${view.name}`}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setMenuOpen(false);
                    setName(view.name);
                    setEditing(view);
                  }}
                >
                  <Pencil className="size-3.5" aria-hidden="true" />
                </Button>
                <Button
                  aria-label={`Xoá ${view.name}`}
                  size="icon"
                  type="button"
                  variant="ghost"
                  onClick={() => {
                    setMenuOpen(false);
                    setDeleting(view);
                  }}
                >
                  <Trash2 className="size-3.5" aria-hidden="true" />
                </Button>
              </div>
            ))}
            {views.length === 0 ? (
              <p className="text-muted-foreground px-3 py-8 text-center text-sm">
                Chưa có view nào được lưu.
              </p>
            ) : null}
          </div>
        </PopoverContent>
      </Popover>

      <Dialog open={saveOpen} onOpenChange={setSaveOpen}>
        <DialogContent>
          <form className="grid gap-4" onSubmit={save}>
            <DialogHeader>
              <DialogTitle>Lưu view hiện tại</DialogTitle>
              <DialogDescription>
                Chỉ pathname và bộ lọc hợp lệ được lưu; dialog, trang hiện tại và lựa chọn tạm thời
                sẽ bị bỏ qua.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="saved-view-name">Tên view</Label>
              <Input
                id="saved-view-name"
                maxLength={60}
                placeholder="Ví dụ: Project A · 30 ngày"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setSaveOpen(false)}>
                Huỷ
              </Button>
              <Button type="submit">Lưu view</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => !open && setEditing(null)}>
        <DialogContent>
          <form className="grid gap-4" onSubmit={commitRename}>
            <DialogHeader>
              <DialogTitle>Đổi tên Saved View</DialogTitle>
              <DialogDescription>Tên mới phải khác các Saved Views hiện có.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="rename-saved-view">Tên view</Label>
              <Input
                id="rename-saved-view"
                maxLength={60}
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setEditing(null)}>
                Huỷ
              </Button>
              <Button type="submit">Lưu tên</Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>

      <Dialog open={deleting !== null} onOpenChange={(open) => !open && setDeleting(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Xoá Saved View?</DialogTitle>
            <DialogDescription>
              {deleting ? `“${deleting.name}” sẽ bị xoá khỏi trình duyệt này.` : ""}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => setDeleting(null)}>
              Huỷ
            </Button>
            <Button
              type="button"
              variant="destructive"
              onClick={() => {
                if (deleting) remove(deleting.id);
                setDeleting(null);
                toast.success("Đã xoá Saved View.");
              }}
            >
              Xoá view
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
