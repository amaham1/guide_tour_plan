import { clsx, type ClassValue } from "clsx";
import { format } from "date-fns";
import { ko } from "date-fns/locale";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function formatDateTime(value: string | Date) {
  return format(new Date(value), "M월 d일 HH:mm", { locale: ko });
}

export function formatClock(value: string | Date) {
  return format(new Date(value), "HH:mm", { locale: ko });
}

export function formatDuration(minutes: number) {
  if (minutes < 60) {
    return `${minutes}분`;
  }

  const hours = Math.floor(minutes / 60);
  const remaining = minutes % 60;
  return remaining === 0 ? `${hours}시간` : `${hours}시간 ${remaining}분`;
}

export function minutesBetween(startAt: string | Date, endAt: string | Date) {
  return Math.round(
    (new Date(endAt).getTime() - new Date(startAt).getTime()) / 60000,
  );
}
