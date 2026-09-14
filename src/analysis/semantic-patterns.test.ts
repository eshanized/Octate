/**
 * Unit tests for Context-Aware Semantic Pattern Analysis.
 */

import { describe, expect, it } from '@jest/globals';
import { analyzeSubprocessCall, analyzeTypeAssertion, isSafeIdiom } from './semantic-patterns.js';

describe('Context-Aware Semantic Patterns', () => {
  describe('analyzeTypeAssertion', () => {
    it('identifies standard benign type assertion', () => {
      const code = `
        const row = result.rows[0] as UserRecord;
        if (!row) {
          return null;
        }
        return row.email;
      `;
      const result = analyzeTypeAssertion(code);
      expect(result.isTypeAssertion).toBe(true);
      expect(result.isBenignAssertion).toBe(true);
      expect(result.flowsToDangerousSink).toBe(false);
      expect(result.riskLevel).toBe('safe');
    });

    it('identifies type assertion flowing into eval sink as high risk', () => {
      const code = `
        const script = payload as ScriptPayload;
        eval(script.code);
      `;
      const result = analyzeTypeAssertion(code);
      expect(result.isTypeAssertion).toBe(true);
      expect(result.isBenignAssertion).toBe(false);
      expect(result.flowsToDangerousSink).toBe(true);
      expect(result.dangerousSinkName).toBe('eval');
      expect(result.riskLevel).toBe('high');
    });

    it('identifies type assertion flowing into innerHTML as high risk', () => {
      const code = `
        const user = data as UserProfile;
        container.innerHTML = user.bio;
      `;
      const result = analyzeTypeAssertion(code);
      expect(result.flowsToDangerousSink).toBe(true);
      expect(result.dangerousSinkName).toBe('innerHTML');
      expect(result.riskLevel).toBe('high');
    });
  });

  describe('analyzeSubprocessCall', () => {
    it('identifies static list subprocess call as safe', () => {
      const code = `
        subprocess.run(["git", "status"], check=True, capture_output=True)
      `;
      const result = analyzeSubprocessCall(code);
      expect(result.isSubprocessCall).toBe(true);
      expect(result.isListForm).toBe(true);
      expect(result.hasUntrustedArgument).toBe(false);
      expect(result.riskLevel).toBe('safe');
    });

    it('identifies dynamic argument without validation as argument injection risk', () => {
      const code = `
        def fetch_branch(user_branch):
          subprocess.run(["git", "fetch", user_branch], check=True)
      `;
      const result = analyzeSubprocessCall(code);
      expect(result.isSubprocessCall).toBe(true);
      expect(result.isListForm).toBe(true);
      expect(result.hasUntrustedArgument).toBe(true);
      expect(result.hasArgumentValidation).toBe(false);
      expect(result.riskLevel).toBe('critical');
      expect(result.riskType).toBe('argument_injection');
    });

    it('identifies dynamic argument with input validation guard as safe', () => {
      const code = `
        def fetch_branch(user_branch):
          if not re.match(r'^[a-zA-Z0-9_.-]+$', user_branch):
            raise ValueError("Invalid branch")
          subprocess.run(["git", "fetch", user_branch], check=True)
      `;
      const result = analyzeSubprocessCall(code);
      expect(result.isSubprocessCall).toBe(true);
      expect(result.isListForm).toBe(true);
      expect(result.hasArgumentValidation).toBe(true);
      expect(result.riskLevel).toBe('safe');
      expect(result.riskType).toBe('safe_execution');
    });

    it('identifies shell=True with interpolated string as shell injection risk', () => {
      const code = `
        cmd = f"ping -c 1 {host}"
        subprocess.run(cmd, shell=True)
      `;
      const result = analyzeSubprocessCall(code);
      expect(result.isSubprocessCall).toBe(true);
      expect(result.usesShell).toBe(true);
      expect(result.riskLevel).toBe('critical');
      expect(result.riskType).toBe('shell_injection');
    });
  });

  describe('isSafeIdiom', () => {
    it('recognizes intentional domain exceptions', () => {
      expect(isSafeIdiom('throw new NotFoundError("User not found");')).toBe(true);
      expect(isSafeIdiom('raise ValueError("Invalid configuration");')).toBe(true);
    });

    it('recognizes bounded loops', () => {
      expect(isSafeIdiom('for (let i = 0; i < users.length; i++) { process(users[i]); }')).toBe(
        true
      );
      expect(isSafeIdiom('for i in range(10): print(i)')).toBe(true);
    });

    it('recognizes safe type assertions', () => {
      expect(isSafeIdiom('const row = result.rows[0] as UserRecord; return row;')).toBe(true);
    });

    it('recognizes safe subprocess executions', () => {
      expect(isSafeIdiom('subprocess.run(["git", "log", "-n", "1"], check=True)')).toBe(true);
    });
  });
});
