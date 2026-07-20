import { BellRing, LoaderCircle } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "@/web/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/web/components/ui/card";
import { Input } from "@/web/components/ui/input";
import { Label } from "@/web/components/ui/label";
import {
  useBrowserNotificationPreferences,
  type AlertTypePreference,
} from "@/web/lib/browser-notifications";

const typeLabels: Record<AlertTypePreference, string> = {
  anomaly: "Usage bất thường",
  budget: "Vượt budget",
  "context-pressure": "Context pressure",
  "data-health": "Sức khoẻ dữ liệu",
};

export function NotificationSettings() {
  const { permission, preferences, requestEnable, setPreferences } =
    useBrowserNotificationPreferences();
  const [requesting, setRequesting] = useState(false);

  async function toggleEnabled() {
    if (preferences.enabled) {
      setPreferences({ ...preferences, enabled: false, enabledAt: null });
      return;
    }
    setRequesting(true);
    try {
      const result = await requestEnable();
      if (result === "granted") toast.success("Đã bật browser notification.");
      else if (result === "denied") toast.error("Trình duyệt đã từ chối quyền thông báo.");
      else toast.error("Trình duyệt không hỗ trợ notification.");
    } finally {
      setRequesting(false);
    }
  }

  function toggleType(type: AlertTypePreference) {
    const types = preferences.types.includes(type)
      ? preferences.types.filter((value) => value !== type)
      : [...preferences.types, type];
    setPreferences({ ...preferences, types });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <BellRing className="text-primary size-4" aria-hidden="true" />
          Browser notification
        </CardTitle>
        <CardDescription>
          Chỉ gửi alert warning/critical khi dashboard đang mở; không gửi dữ liệu ra dịch vụ ngoài.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-center">
          <div>
            <p className="text-sm font-medium">{preferences.enabled ? "Đang bật" : "Đang tắt"}</p>
            <p className="text-muted-foreground text-xs">Quyền trình duyệt: {permission}</p>
          </div>
          <Button
            disabled={requesting}
            type="button"
            variant="outline"
            onClick={() => void toggleEnabled()}
          >
            {requesting ? <LoaderCircle className="size-4 animate-spin" /> : null}
            {preferences.enabled ? "Tắt thông báo" : "Bật thông báo"}
          </Button>
        </div>

        <fieldset className="grid gap-3 sm:grid-cols-2">
          <legend className="mb-2 text-sm font-medium">Loại cảnh báo</legend>
          {(Object.keys(typeLabels) as AlertTypePreference[]).map((type) => (
            <label
              key={type}
              className="flex min-h-10 items-center gap-3 rounded-lg border px-3 py-2 text-sm"
            >
              <input
                checked={preferences.types.includes(type)}
                className="accent-primary size-4"
                type="checkbox"
                onChange={() => toggleType(type)}
              />
              {alertTypeLabel(type)}
            </label>
          ))}
        </fieldset>

        <div className="space-y-3 rounded-lg border p-4">
          <label className="flex items-center gap-3 text-sm font-medium">
            <input
              checked={preferences.quietHours.enabled}
              className="accent-primary size-4"
              type="checkbox"
              onChange={(event) =>
                setPreferences({
                  ...preferences,
                  quietHours: { ...preferences.quietHours, enabled: event.target.checked },
                })
              }
            />
            Bật quiet hours theo Asia/Ho_Chi_Minh
          </label>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-2">
              <Label htmlFor="quiet-hours-start">Bắt đầu</Label>
              <Input
                id="quiet-hours-start"
                type="time"
                value={preferences.quietHours.start}
                onChange={(event) =>
                  setPreferences({
                    ...preferences,
                    quietHours: { ...preferences.quietHours, start: event.target.value },
                  })
                }
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="quiet-hours-end">Kết thúc</Label>
              <Input
                id="quiet-hours-end"
                type="time"
                value={preferences.quietHours.end}
                onChange={(event) =>
                  setPreferences({
                    ...preferences,
                    quietHours: { ...preferences.quietHours, end: event.target.value },
                  })
                }
              />
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function alertTypeLabel(type: AlertTypePreference): string {
  switch (type) {
    case "anomaly":
      return typeLabels.anomaly;
    case "budget":
      return typeLabels.budget;
    case "context-pressure":
      return typeLabels["context-pressure"];
    case "data-health":
      return typeLabels["data-health"];
  }
}
