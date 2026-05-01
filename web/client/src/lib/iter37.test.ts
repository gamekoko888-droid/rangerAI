/**
 * Iter-37 Tests: Unified form validation utilities
 */
import { describe, it, expect } from 'vitest';
import {
  isNotEmpty,
  hasMinLength,
  hasMaxLength,
  matchesPattern,
  valuesMatch,
  validateField,
  validateFields,
  required,
  minLength,
  maxLength,
  pattern,
  usernameRules,
  passwordRules,
  inviteCodeRules,
  requiredTextRules,
} from './formValidation';

describe('Iter-37: Primitive validators', () => {
  describe('isNotEmpty', () => {
    it('returns true for non-empty string', () => {
      expect(isNotEmpty('hello')).toBe(true);
    });
    it('returns false for empty string', () => {
      expect(isNotEmpty('')).toBe(false);
    });
    it('returns false for whitespace-only string', () => {
      expect(isNotEmpty('   ')).toBe(false);
    });
  });

  describe('hasMinLength', () => {
    it('returns true when length >= min', () => {
      expect(hasMinLength('abcdef', 6)).toBe(true);
    });
    it('returns false when length < min', () => {
      expect(hasMinLength('abc', 6)).toBe(false);
    });
  });

  describe('hasMaxLength', () => {
    it('returns true when length <= max', () => {
      expect(hasMaxLength('abc', 5)).toBe(true);
    });
    it('returns false when length > max', () => {
      expect(hasMaxLength('abcdef', 5)).toBe(false);
    });
  });

  describe('matchesPattern', () => {
    it('returns true for matching pattern', () => {
      expect(matchesPattern('abc123', /^[a-z0-9]+$/)).toBe(true);
    });
    it('returns false for non-matching pattern', () => {
      expect(matchesPattern('abc 123', /^[a-z0-9]+$/)).toBe(false);
    });
  });

  describe('valuesMatch', () => {
    it('returns true for matching values', () => {
      expect(valuesMatch('password', 'password')).toBe(true);
    });
    it('returns false for non-matching values', () => {
      expect(valuesMatch('password', 'different')).toBe(false);
    });
  });
});

describe('Iter-37: Composite validators', () => {
  describe('validateField', () => {
    it('returns valid for passing rules', () => {
      const result = validateField('hello', [required('err.required')]);
      expect(result.valid).toBe(true);
      expect(result.errorKey).toBeUndefined();
    });
    it('returns first failing rule error', () => {
      const result = validateField('', [
        required('err.required'),
        minLength(6, 'err.tooShort'),
      ]);
      expect(result.valid).toBe(false);
      expect(result.errorKey).toBe('err.required');
    });
    it('returns second rule error when first passes', () => {
      const result = validateField('ab', [
        required('err.required'),
        minLength(6, 'err.tooShort'),
      ]);
      expect(result.valid).toBe(false);
      expect(result.errorKey).toBe('err.tooShort');
    });
  });

  describe('validateFields', () => {
    it('returns valid when all fields pass', () => {
      const result = validateFields([
        { value: 'user', rules: [required('err.required')] },
        { value: 'password123', rules: [required('err.required'), minLength(6, 'err.short')] },
      ]);
      expect(result.valid).toBe(true);
    });
    it('returns first field error', () => {
      const result = validateFields([
        { value: '', rules: [required('err.username')] },
        { value: '', rules: [required('err.password')] },
      ]);
      expect(result.valid).toBe(false);
      expect(result.errorKey).toBe('err.username');
    });
    it('returns second field error when first passes', () => {
      const result = validateFields([
        { value: 'user', rules: [required('err.username')] },
        { value: 'abc', rules: [required('err.password'), minLength(6, 'err.short')] },
      ]);
      expect(result.valid).toBe(false);
      expect(result.errorKey).toBe('err.short');
    });
  });
});

describe('Iter-37: Rule factories', () => {
  it('required rule fails on empty', () => {
    const rule = required('err.req');
    expect(rule.test('')).toBe(false);
    expect(rule.test('a')).toBe(true);
    expect(rule.messageKey).toBe('err.req');
  });

  it('minLength rule checks minimum', () => {
    const rule = minLength(6, 'err.short');
    expect(rule.test('abc')).toBe(false);
    expect(rule.test('abcdef')).toBe(true);
  });

  it('maxLength rule checks maximum', () => {
    const rule = maxLength(10, 'err.long');
    expect(rule.test('short')).toBe(true);
    expect(rule.test('this is too long string')).toBe(false);
  });

  it('pattern rule checks regex', () => {
    const rule = pattern(/^\d+$/, 'err.digits');
    expect(rule.test('123')).toBe(true);
    expect(rule.test('abc')).toBe(false);
  });
});

describe('Iter-37: Pre-built rule sets', () => {
  const mockT = (k: string) => k;

  it('usernameRules has required + minLength + maxLength', () => {
    const rules = usernameRules(mockT);
    expect(rules.length).toBe(3);
    expect(rules[0].test('')).toBe(false); // required
    expect(rules[1].test('a')).toBe(false); // minLength 2
    expect(rules[1].test('ab')).toBe(true);
    expect(rules[2].test('a'.repeat(31))).toBe(false); // maxLength 30
  });

  it('passwordRules has required + minLength', () => {
    const rules = passwordRules(mockT);
    expect(rules.length).toBe(2);
    expect(rules[0].test('')).toBe(false);
    expect(rules[1].test('abc')).toBe(false);
    expect(rules[1].test('abcdef')).toBe(true);
  });

  it('inviteCodeRules has required', () => {
    const rules = inviteCodeRules();
    expect(rules.length).toBe(1);
    expect(rules[0].test('')).toBe(false);
    expect(rules[0].test('INV-123')).toBe(true);
  });

  it('requiredTextRules has required with custom key', () => {
    const rules = requiredTextRules('custom.error');
    expect(rules.length).toBe(1);
    expect(rules[0].messageKey).toBe('custom.error');
  });
});

describe('Iter-37: Integration - pages use formValidation', () => {
  const fs = require('fs');
  const path = require('path');
  const clientSrc = path.resolve(__dirname, '..');

  it('LoginPage imports from formValidation', () => {
    const src = fs.readFileSync(path.join(clientSrc, 'pages/LoginPage.tsx'), 'utf-8');
    expect(src).toContain("from '../lib/formValidation'");
    expect(src).toContain('validateFields');
  });

  it('TeamManagement imports from formValidation', () => {
    const src = fs.readFileSync(path.join(clientSrc, 'pages/TeamManagement.tsx'), 'utf-8');
    expect(src).toContain("from '../lib/formValidation'");
    expect(src).toContain('validateFields');
  });

  it('i18n has validation.* keys', () => {
    const src = fs.readFileSync(path.join(clientSrc, 'lib/i18n.tsx'), 'utf-8');
    expect(src).toContain("'validation.usernameTooShort'");
    expect(src).toContain("'validation.usernameTooLong'");
    expect(src).toContain("'validation.fieldRequired'");
    expect(src).toContain("'validation.nameTooLong'");
  });
});
