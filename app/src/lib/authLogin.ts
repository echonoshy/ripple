import { isValidUserId } from "@/lib/api";

const DEFAULT_LOGIN_USER_ID = "default";
const USER_ID_VALIDATION_MESSAGE = "Use letters, numbers, underscores, or hyphens.";

export function normalizeLoginUserId(value: string): string {
  return value.trim() || DEFAULT_LOGIN_USER_ID;
}

export function initialLoginUserIdInput(userId: string): string {
  return userId === DEFAULT_LOGIN_USER_ID ? "" : userId;
}

export function loginUserIdValidationMessage(value: string): string | null {
  return isValidUserId(normalizeLoginUserId(value)) ? null : USER_ID_VALIDATION_MESSAGE;
}
