# Octate Configuration Reference

Octate is configured via a YAML file named `octate.yaml` placed at your repository root or discovered in parent directories.

---

## Configuration Hierarchy & Precedence

Octate resolves configuration values through a deterministic 5-tier merge cascade:

```
Default Config < Global (~/.config/octate/config.yaml) < Project (octate.yaml) < Environment Variables < CLI Flags
```

Higher tiers override only values explicitly set in that layer. For example, passing `--fail-on high` on the CLI overrides `review.failOnSeverity`; an omitted project setting does not erase an explicit global setting.

---

## Complete `octate.yaml` Example

```yaml
version: "1.0.0"

project:
  name: "MyApplication"

review:
  severity: medium
  failOnSeverity: high
  maxFindings: 25
  minConfidence: 0.65

rules: []

architecture:
  boundaries:
    - "src/domain/**"
  forbiddenDependencies:
    - "express"
    - "koa"

ignore:
  - "**/*.min.js"
  - "**/*.generated.ts"
  - "dist/**"
```

---

## Field Specifications

### version
- Required string in semantic version format, such as `1.0.0`.

### project
- `name`: required non-empty project name.

### review
- `severity`: minimum severity to include (`critical`, `high`, `medium`, `low`, or `info`).
- `failOnSeverity`: severity that triggers a non-zero exit code (`critical`, `high`, `medium`, `low`, `info`, `none`, or `off`).
- `maxFindings`: positive integer from 1 to 100.
- `minConfidence`: number from 0 to 1 used by the deterministic review gate.

### rules
- Array of strings naming rules to apply. Rule objects are not supported by the current schema.

### architecture
- `boundaries`: array of path/pattern strings.
- `forbiddenDependencies`: array of module names or patterns.
- Set `architecture: null` to reset architecture constraints to empty arrays.

### ignore
- Array of glob patterns applied in addition to `.gitignore`, `.octateignore`, and always-excluded generated/dependency directories.

The schema rejects unsupported keys, so only configure fields listed here. Cache settings, project descriptions/language lists, rule objects, and object-shaped architecture boundaries are not currently part of the configuration contract.
