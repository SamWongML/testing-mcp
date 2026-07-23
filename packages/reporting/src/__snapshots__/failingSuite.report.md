# Report — billing.e2e-refund

- **Status:** failed
- **Run:** run-fail-suite
- **Kind:** suite
- **Env:** local
- **Steps:** 2/4 passed
- **Assertions:** 2/3 passed
- **Duration:** 210ms
- **Manifest:** sha256:def456
- **Git SHA:** cafef00d

## Steps

| Step | Status | Attempts | Time |
|---|---|---|---|
| login | ✅ passed | 1 | 30ms |
| refund | ✅ passed | 1 | 55ms |
| verify | ❌ failed | 1 | 120ms |
| notify | ⏭️ skipped | 0 | — |

## Likely cause

**assertion-failed** — Step "verify" assertion eq at $.state failed: expected "settled", actual "pending".

_Next action: Compare expected vs actual — update the assertion or fix the SUT._

## Failures

### verify — failed

- **Request:** `GET http://sut.local/ledger/refunds/rf_1`
- **Response:** `200`
- **Assertions:**
  - ❌ `eq` at `$.state` — expected `"settled"`, actual `"pending"` — ledger not yet settled
