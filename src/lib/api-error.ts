import { ZodError } from "zod";

type ErrorWithStatus = Error & {
  status?: number;
};

export function getErrorStatus(error: unknown) {
  if (error instanceof ZodError) {
    return 400;
  }

  if (error instanceof Error && "status" in error) {
    return (error as ErrorWithStatus).status ?? 500;
  }

  return 500;
}

export function getErrorMessage(error: unknown, fallback: string) {
  if (error instanceof ZodError) {
    return error.issues[0]?.message ?? fallback;
  }

  return error instanceof Error ? error.message : fallback;
}
