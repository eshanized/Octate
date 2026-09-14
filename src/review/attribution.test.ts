/**
 * Unit tests for Deterministic Patch Attribution Engine.
 */

import { describe, expect, it } from '@jest/globals';
import type { ModelFinding } from '../model/types.js';
import { attributeAllFindings, determinePatchAttribution } from './attribution.js';

function makeFinding(overrides?: Partial<ModelFinding>): ModelFinding {
  return {
    severity: 'high',
    category: 'security',
    title: 'SQL Injection in query',
    message: 'User input passed unsanitized to SQL query',
    file: 'src/db/users.ts',
    startLine: 15,
    endLine: 20,
    confidence: 0.9,
    evidence: [],
    relatedFiles: [],
    relatedSymbols: [],
    impact: 'Unauthorized DB access',
    suggestedFix: 'Use parameterized query',
    reviewer: 'security',
    ...overrides,
  };
}

describe('Patch Attribution Engine', () => {
  const sampleDiff = `diff --git a/src/db/users.ts b/src/db/users.ts
--- a/src/db/users.ts
+++ b/src/db/users.ts
@@ -10,3 +10,5 @@
 context
-const oldQuery = "SELECT * FROM users WHERE id = " + id;
+const query = "SELECT * FROM users WHERE id = " + req.query.id;
+const result = await db.query(query);
 context
diff --git a/src/legacy.ts b/src/legacy.ts
deleted file mode 100644
--- a/src/legacy.ts
+++ /dev/null
@@ -1,5 +0,0 @@
-const dead = true;
`;

  it('classifies findings overlapping added/modified lines as introduced_by_patch', () => {
    const finding = makeFinding({
      file: 'src/db/users.ts',
      startLine: 11,
      endLine: 12,
    });

    const attribution = determinePatchAttribution(finding, { diff: sampleDiff });
    expect(attribution).toBe('introduced_by_patch');
  });

  it('classifies findings in unchanged lines of a changed file as pre_existing', () => {
    const finding = makeFinding({
      file: 'src/db/users.ts',
      startLine: 50,
      endLine: 55,
    });

    const attribution = determinePatchAttribution(finding, { diff: sampleDiff });
    expect(attribution).toBe('pre_existing');
  });

  it('classifies findings in unchanged lines with causal link as worsened_by_patch', () => {
    const finding = makeFinding({
      file: 'src/db/users.ts',
      startLine: 50,
      endLine: 55,
      evidence: [
        {
          file: 'src/db/users.ts',
          startLine: 50,
          endLine: 55,
          relationship: 'sink',
          explanation: 'Called by newly modified query at line 11',
          causalLink: 'New query at line 11 passes untrusted tenantId into this function',
        },
      ],
    });

    const attribution = determinePatchAttribution(finding, { diff: sampleDiff });
    expect(attribution).toBe('worsened_by_patch');
  });

  it('classifies findings in deleted lines as fixed_by_patch', () => {
    const finding = makeFinding({
      file: 'src/db/users.ts',
      startLine: 10,
      endLine: 11,
      title: 'Old vulnerability fixed in this patch',
      message: 'The vulnerable string concatenation was removed and deleted',
    });

    const attribution = determinePatchAttribution(finding, { diff: sampleDiff });
    expect(attribution).toBe('fixed_by_patch');
  });

  it('classifies findings in unchanged files with causal link as worsened_by_patch', () => {
    const finding = makeFinding({
      file: 'src/services/auth.ts',
      startLine: 30,
      endLine: 35,
      evidence: [
        {
          file: 'src/services/auth.ts',
          startLine: 30,
          endLine: 35,
          relationship: 'callee',
          explanation: 'Called from src/db/users.ts:11 without validating authorization',
          causalLink: 'New route in src/db/users.ts calls this method without role check',
          tier: 'supporting_context',
        },
      ],
    });

    const attribution = determinePatchAttribution(finding, { diff: sampleDiff });
    expect(attribution).toBe('worsened_by_patch');
  });

  it('classifies findings in unchanged files without causal link as unrelated_to_patch', () => {
    const finding = makeFinding({
      file: 'src/utils/math.ts',
      startLine: 5,
      endLine: 10,
    });

    const attribution = determinePatchAttribution(finding, { diff: sampleDiff });
    expect(attribution).toBe('unrelated_to_patch');
  });

  it('attributes a batch of findings correctly with attributeAllFindings', () => {
    const introduced = makeFinding({ file: 'src/db/users.ts', startLine: 11, endLine: 12 });
    const preExisting = makeFinding({ file: 'src/db/users.ts', startLine: 80, endLine: 85 });
    const unrelated = makeFinding({ file: 'src/config/app.ts', startLine: 1, endLine: 5 });

    const attributed = attributeAllFindings([introduced, preExisting, unrelated], {
      diff: sampleDiff,
    });
    expect(attributed[0]?.introducedByPatch).toBe('introduced_by_patch');
    expect(attributed[1]?.introducedByPatch).toBe('pre_existing');
    expect(attributed[2]?.introducedByPatch).toBe('unrelated_to_patch');
  });
});
