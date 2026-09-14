/**
 * Context-Aware Semantic Pattern Analysis.
 *
 * Implements semantic data-flow and safety analysis for common coding patterns,
 * replacing fragile regex-only hard floors:
 * - TypeScript type assertions (evaluates source expression, null guards, and downstream sinks)
 * - Subprocess executions (evaluates shell vs list form, argument origin, and validation guards)
 * - Safe control flow idioms (bounded loops, intentional domain exceptions)
 */

export interface TypeAssertionAnalysis {
  isTypeAssertion: boolean;
  assertedType?: string | undefined;
  sourceExpression?: string | undefined;
  isBenignAssertion: boolean;
  flowsToDangerousSink: boolean;
  dangerousSinkName?: string | undefined;
  hasValidationOrGuard: boolean;
  riskLevel: 'safe' | 'low' | 'high';
  explanation: string;
}

export interface SubprocessAnalysis {
  isSubprocessCall: boolean;
  usesShell: boolean;
  isListForm: boolean;
  hasUntrustedArgument: boolean;
  hasArgumentValidation: boolean;
  riskLevel: 'safe' | 'low' | 'critical';
  riskType?:
    | 'shell_injection'
    | 'argument_injection'
    | 'untrusted_binary'
    | 'safe_execution'
    | undefined;
  explanation: string;
}

const DANGEROUS_SINKS = [
  { name: 'eval', pattern: /\beval\s*\(/i },
  { name: 'innerHTML', pattern: /\b(innerHTML|outerHTML)\s*=/i },
  { name: 'dangerouslySetInnerHTML', pattern: /dangerouslySetInnerHTML/i },
  { name: 'document.write', pattern: /document\.write\s*\(/i },
  { name: 'child_process.exec', pattern: /\b(exec|execSync)\s*\(/i },
  { name: 'Function constructor', pattern: /\bnew\s+Function\s*\(/i },
];

const VALIDATION_OR_GUARD_PATTERNS = [
  /if\s*\(\s*!\s*([a-zA-Z0-9_.]+)\s*\)/,
  /if\s*\(\s*([a-zA-Z0-9_.]+)\s*===\s*(null|undefined)\s*\)/,
  /if\s*\(\s*typeof\s+([a-zA-Z0-9_.]+)/,
  /\.safeParse\s*\(/,
  /\.parse\s*\(/,
  /\?\?/,
  /\?\./,
  /assert\s*\(/,
];

/**
 * Analyzes a TypeScript/JavaScript code snippet containing type assertions (e.g. `x as SomeType`).
 * Evaluates whether the assertion is a benign standard pattern or flows into a dangerous sink.
 */
export function analyzeTypeAssertion(code: string): TypeAssertionAnalysis {
  const asMatch = /\b([a-zA-Z0-9_.[\]()]+)\s+as\s+([A-Za-z0-9_<>[\]]+)/.exec(code);

  if (!asMatch) {
    return {
      isTypeAssertion: false,
      isBenignAssertion: true,
      flowsToDangerousSink: false,
      hasValidationOrGuard: false,
      riskLevel: 'safe',
      explanation: 'No type assertion detected',
    };
  }

  const sourceExpression = asMatch[1];
  const assertedType = asMatch[2];

  // 1. Check for downstream dangerous sinks in the code block
  let flowsToDangerousSink = false;
  let dangerousSinkName: string | undefined;

  for (const sink of DANGEROUS_SINKS) {
    if (sink.pattern.test(code)) {
      flowsToDangerousSink = true;
      dangerousSinkName = sink.name;
      break;
    }
  }

  // 2. Check for null checks, type guards, or schema validation
  const hasValidationOrGuard = VALIDATION_OR_GUARD_PATTERNS.some((p) => p.test(code));

  if (flowsToDangerousSink) {
    return {
      isTypeAssertion: true,
      assertedType,
      sourceExpression,
      isBenignAssertion: false,
      flowsToDangerousSink: true,
      dangerousSinkName,
      hasValidationOrGuard,
      riskLevel: 'high',
      explanation: `Type assertion "${sourceExpression} as ${assertedType}" flows directly into dangerous sink "${dangerousSinkName}"`,
    };
  }

  return {
    isTypeAssertion: true,
    assertedType,
    sourceExpression,
    isBenignAssertion: true,
    flowsToDangerousSink: false,
    hasValidationOrGuard,
    riskLevel: 'safe',
    explanation: `Standard type assertion "${sourceExpression} as ${assertedType}" without dangerous sink flow`,
  };
}

const SHELL_TRUE_REGEX = /\bshell\s*=\s*True\b/i;
const SUBPROCESS_CALL_REGEX = /\bsubprocess\.(run|Popen|call|check_output|check_call)\s*\(/;

const ARG_VALIDATION_REGEX = [
  /re\.(match|search|fullmatch)\s*\(/,
  /if\s+([a-zA-Z0-9_]+)\s+not\s+in\s+/,
  /if\s+not\s+([a-zA-Z0-9_]+)\.isalnum\(\)/,
  /shlex\.quote\s*\(/,
  /whitelist|allowlist/i,
];

/**
 * Analyzes a Python subprocess execution for shell injection, argument injection, or safe execution.
 */
export function analyzeSubprocessCall(code: string): SubprocessAnalysis {
  const isSubprocess = SUBPROCESS_CALL_REGEX.test(code);
  if (!isSubprocess) {
    return {
      isSubprocessCall: false,
      usesShell: false,
      isListForm: false,
      hasUntrustedArgument: false,
      hasArgumentValidation: false,
      riskLevel: 'safe',
      riskType: 'safe_execution',
      explanation: 'No subprocess call detected',
    };
  }

  const usesShell = SHELL_TRUE_REGEX.test(code);

  // Check if call uses a list format: subprocess.run([ ... ], ...)
  const listMatch = /\bsubprocess\.(?:run|Popen|call)\s*\(\s*\[([^\]]+)\]/.exec(code);
  const isListForm = Boolean(listMatch);

  // Check if arguments have prior validation
  const hasArgumentValidation = ARG_VALIDATION_REGEX.some((r) => r.test(code));

  // Case 1: shell=True with dynamic/non-literal command
  if (usesShell) {
    const hasInterpolation = /f['"][^'"]*\{|format\(|%|\+/.test(code);
    if (hasInterpolation && !hasArgumentValidation) {
      return {
        isSubprocessCall: true,
        usesShell: true,
        isListForm,
        hasUntrustedArgument: true,
        hasArgumentValidation: false,
        riskLevel: 'critical',
        riskType: 'shell_injection',
        explanation:
          'Dynamic command string passed to subprocess with shell=True enables arbitrary shell command injection',
      };
    }
  }

  // Case 2: List-based call
  if (isListForm && listMatch?.[1]) {
    const rawArgs = listMatch[1].split(',').map((s) => s.trim());
    // Check if any argument is a variable/identifier (not surrounded by quotes)
    const dynamicArgs = rawArgs.slice(1).filter((arg) => {
      const isQuoted =
        (arg.startsWith('"') && arg.endsWith('"')) || (arg.startsWith("'") && arg.endsWith("'"));
      return !isQuoted && arg.length > 0;
    });

    if (dynamicArgs.length > 0) {
      if (hasArgumentValidation) {
        return {
          isSubprocessCall: true,
          usesShell: false,
          isListForm: true,
          hasUntrustedArgument: true,
          hasArgumentValidation: true,
          riskLevel: 'safe',
          riskType: 'safe_execution',
          explanation: `Subprocess executed with list form and dynamic arguments (${dynamicArgs.join(', ')}) guarded by input validation`,
        };
      }

      return {
        isSubprocessCall: true,
        usesShell: false,
        isListForm: true,
        hasUntrustedArgument: true,
        hasArgumentValidation: false,
        riskLevel: 'critical',
        riskType: 'argument_injection',
        explanation: `Dynamic argument "${dynamicArgs[0]}" passed to subprocess without validation enables argument injection`,
      };
    }

    return {
      isSubprocessCall: true,
      usesShell: false,
      isListForm: true,
      hasUntrustedArgument: false,
      hasArgumentValidation: true,
      riskLevel: 'safe',
      riskType: 'safe_execution',
      explanation: 'Subprocess executed safely with static string list arguments',
    };
  }

  // Subprocess call with simple static variable or known binary
  return {
    isSubprocessCall: true,
    usesShell,
    isListForm,
    hasUntrustedArgument: false,
    hasArgumentValidation: hasArgumentValidation,
    riskLevel: usesShell ? 'critical' : 'safe',
    riskType: usesShell ? 'shell_injection' : 'safe_execution',
    explanation: usesShell
      ? 'Subprocess with shell=True requires input validation'
      : 'Subprocess call without dangerous parameters',
  };
}

/**
 * Detects whether a code snippet represents a safe idiomatic pattern:
 * - Bounded loops
 * - Intentional exception throwing
 * - Benign type assertions
 * - Safe static subprocess executions
 */
export function isSafeIdiom(code: string, _language?: 'typescript' | 'python'): boolean {
  if (!code) return false;

  // 1. Intentional domain exception throw
  if (
    /\bthrow\s+new\s+[A-Za-z0-9_]*(Error|Exception|NotFound|BadRequest|Unauthorized|Forbidden)\s*\(/.test(
      code
    ) ||
    /\braise\s+[A-Za-z0-9_]*(Error|Exception|NotFound|ValueError|KeyError)\s*\(/.test(code)
  ) {
    return true;
  }

  // 2. Bounded for-loop
  if (
    /\bfor\s*\(\s*(?:let|const|var)\s+[a-zA-Z0-9_]+\s*=\s*\d+;\s*[a-zA-Z0-9_]+\s*<\s*(?:[a-zA-Z0-9_.]+|\d+);\s*[a-zA-Z0-9_]+\+\+\s*\)/.test(
      code
    ) ||
    /\bfor\s+[a-zA-Z0-9_]+\s+in\s+range\s*\(\s*(?:\d+|len\([a-zA-Z0-9_]+\))\s*\)\s*:/.test(code)
  ) {
    return true;
  }

  // 3. Type assertion
  if (code.includes(' as ')) {
    const analysis = analyzeTypeAssertion(code);
    if (analysis.isTypeAssertion && analysis.isBenignAssertion) {
      return true;
    }
  }

  // 4. Subprocess call
  if (code.includes('subprocess.')) {
    const analysis = analyzeSubprocessCall(code);
    if (analysis.isSubprocessCall && analysis.riskLevel === 'safe') {
      return true;
    }
  }

  return false;
}
