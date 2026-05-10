import { getNotificationWebhookUrl } from "@/lib/settings-store";
import type { NotificationPayload } from "@/lib/types";

export async function sendDigestNotification(payload: NotificationPayload) {
  const webhookUrl = getNotificationWebhookUrl();

  if (!webhookUrl) {
    return { delivered: false, provider: "none" as const };
  }

  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(payload)
  });

  return {
    delivered: response.ok,
    provider: "webhook" as const
  };
}
