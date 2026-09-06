# Backup notification evidence report

Data: SYNTHETIC DEMO

**Restore verification has not been performed. Email claims do not prove recoverability.**

Assessed at: 2026-09-05T22:00:00.000Z

| Job | Run | Email claim | Sender authentication | Source messages | Review |
| --- | --- | --- | --- | --- | --- |
| demo-empty | demo-run-2 | success | pass | demo-empty-success | empty\_artifact\_reported, restore\_not\_reported |
| demo-nightly | demo-run-1 | failed | pass | demo-failure-1, demo-failure-2, demo-failure-3 | artifact\_evidence\_missing, backup\_failure\_reported, restore\_not\_reported |
| demo-nightly | demo-run-1 | success | unknown | demo-untrusted-success | restore\_not\_reported, sender\_authentication\_unknown |
| demo-restore | demo-run-3 | success | pass | demo-restore-claim | restore\_pass\_claim\_unverified |

## Review queue

- empty\_artifact: demo-empty-success — empty\_artifact\_reported, restore\_not\_reported
- backup\_failure: demo-failure-1, demo-failure-2, demo-failure-3 — artifact\_evidence\_missing, backup\_failure\_reported, restore\_not\_reported
- review\_required: demo-untrusted-success — restore\_not\_reported, sender\_authentication\_unknown
- review\_required: demo-restore-claim — restore\_pass\_claim\_unverified
- review: demo-quarantined — scan\_not\_clean
- review: demo-unstructured — unstructured\_body
