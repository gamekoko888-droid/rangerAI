/**
 * Unified form validation utilities for RangerAI
 * 
 * Provides consistent validation patterns across all forms:
 * - LoginPage (login/register)
 * - TeamManagement (create/edit user, reset password)
 * - InviteCodesPage (create invite code)
 * - PromptTemplates (create/edit prompt)
 * - WorkflowEditor (create/edit workflow)
 * - KnowledgeBase (upload/add text)
 */

export interface ValidationRule {
  test: (value: string) => boolean;
  messageKey: string;
}

export interface ValidationResult {
  valid: boolean;
  errorKey?: string;
}

// --- Primitive validators ---

export function isNotEmpty(value: string): boolean {
  return value.trim().length > 0;
}

export function hasMinLength(value: string, min: number): boolean {
  return value.length >= min;
}

export function hasMaxLength(value: string, max: number): boolean {
  return value.length <= max;
}

export function matchesPattern(value: string, pattern: RegExp): boolean {
  return pattern.test(value);
}

export function valuesMatch(a: string, b: string): boolean {
  return a === b;
}

// --- Composite validators ---

/**
 * Validate a single field against a list of rules.
 * Returns the first failing rule's messageKey, or null if all pass.
 */
export function validateField(value: string, rules: ValidationRule[]): ValidationResult {
  for (const rule of rules) {
    if (!rule.test(value)) {
      return { valid: false, errorKey: rule.messageKey };
    }
  }
  return { valid: true };
}

/**
 * Validate multiple fields at once.
 * Returns the first error found, or { valid: true }.
 */
export function validateFields(
  fields: Array<{ value: string; rules: ValidationRule[] }>
): ValidationResult {
  for (const field of fields) {
    const result = validateField(field.value, field.rules);
    if (!result.valid) return result;
  }
  return { valid: true };
}

// --- Common rule factories ---

export const required = (messageKey: string): ValidationRule => ({
  test: (v) => isNotEmpty(v),
  messageKey,
});

export const minLength = (min: number, messageKey: string): ValidationRule => ({
  test: (v) => hasMinLength(v, min),
  messageKey,
});

export const maxLength = (max: number, messageKey: string): ValidationRule => ({
  test: (v) => hasMaxLength(v, max),
  messageKey,
});

export const pattern = (regex: RegExp, messageKey: string): ValidationRule => ({
  test: (v) => matchesPattern(v, regex),
  messageKey,
});

// --- Pre-built validation sets ---

/** Username: required, 2-30 chars, alphanumeric + underscore */
export const usernameRules = (t: (key: string) => string) => [
  required('login.errorEmptyFields'),
  minLength(2, 'validation.usernameTooShort'),
  maxLength(30, 'validation.usernameTooLong'),
];

/** Password: required, min 6 chars */
export const passwordRules = (t: (key: string) => string) => [
  required('login.errorEmptyFields'),
  minLength(6, 'login.errorPasswordTooShort'),
];

/** Invite code: required */
export const inviteCodeRules = () => [
  required('login.errorNoInviteCode'),
];

/** Generic required text field */
export const requiredTextRules = (emptyKey: string) => [
  required(emptyKey),
];
