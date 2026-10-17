# Octate configuration reference

Octate reads `octate.yaml` from the repository root or the nearest parent directory. Global overrides are read from `$XDG_CONFIG_HOME/octate/config.yaml`, or `~/.config/octate/config.yaml` when `XDG_CONFIG_HOME` is not set.

Configuration uses this precedence, from lowest to highest:

```text
built-in defaults < global config < project octate.yaml < OCTATE_* environment variables < explicitly supplied CLI options
```

A layer only overrides fields that it declares. In particular, global configuration files may contain only the settings you want to customize. The `--quiet` flag changes output formatting; it does not change the configured minimum finding severity.

## Supported configuration

```yaml
version: "1.0.0"

project:
  name: "my-application"

review:
  severity: "medium"
  failOnSeverity: "critical"
  maxFindings: 50
  minConfidence: 0.6

rules:
  - "no-hardcoded-secrets"
  - "require-error-handling"

architecture:
  boundaries:
    - "src/domain"
    - "src/api"
  forbiddenDependencies:
    - "src/domain -> src/infrastructure"
    - "lodash"

ignore:
  - "dist/**"
  - "**/*.generated.ts"
  - "vendor/**"
```

## Fields

| Field | Type | Default | Meaning |
|---|---|---|---|
| `version` | semantic-version string | `1.0.0` | Configuration format version; use `x.y.z` such as `1.0.0`. |
| `project.name` | non-empty string | `unnamed-project` | Human-readable project name. Required in `octate.yaml`. |
| `review.severity` | `critical`, `high`, `medium`, `low`, `info` | `medium` | Minimum severity included in final findings. |
| `review.failOnSeverity` | severity, `none`, or `off` | `critical` | Finding threshold that produces a failing exit code. |
| `review.maxFindings` | integer from 1 to 100 | `50` | Maximum final findings returned. |
| `review.minConfidence` | number from 0 to 1 | `0.6` | Minimum confidence threshold used by the critic/decision gate. |
| `rules` | string array | `[]` | Rule names/instructions to provide to the review pipeline. |
| `architecture.boundaries` | string array | `[]` | Declared module/path boundaries. |
| `architecture.forbiddenDependencies` | string array | `[]` | Forbidden dependency names or patterns. |
| `ignore` | string array | `[]` | Additional ignore patterns; repository ignore files are loaded as well. |

The current schema accepts `architecture.boundaries` and `architecture.forbiddenDependencies` as string arrays, not structured objects. It accepts `rules` as strings, not objects. Runtime/cache keys and other settings not shown above are not part of the current `octate.yaml` schema and will be rejected by strict validation.

## Environment variables

Environment variables follow `OCTATE_<SECTION>_<KEY>`. Nested keys use underscores and are converted to camel case:

```sh
OCTATE_PROJECT_NAME=my-application
OCTATE_REVIEW_SEVERITY=high
OCTATE_REVIEW_MAX_FINDINGS=25
OCTATE_REVIEW_FAIL_ON_SEVERITY=high
OCTATE_REVIEW_MIN_CONFIDENCE=0.75
OCTATE_ARCHITECTURE_BOUNDARIES='["src/core","src/api"]'
OCTATE_RULES='["no-console-log","no-hardcoded-secrets"]'
OCTATE_IGNORE='["dist/**","*.generated.ts"]'
```

JSON values are parsed when possible. Top-level `OCTATE_RULES` and `OCTATE_IGNORE` accept JSON arrays or comma-separated values.

## Command-line overrides

Only explicitly supplied policy flags override the configuration. For example:

```sh
octate review --fail-on high
```

The flag overrides `review.failOnSeverity` for that invocation. `--quiet`, `--json`, and `--sarif` select output modes and do not silently reset severity, confidence, or finding-count settings.
